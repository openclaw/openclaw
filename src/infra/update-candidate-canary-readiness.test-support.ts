import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import * as timerPromises from "node:timers/promises";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import * as logger from "../logger.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./net/proxy/active-proxy-state.js";
import { startProxy, stopProxy, type ProxyHandle } from "./net/proxy/proxy-lifecycle.js";
import {
  observeUpdateCandidateStartup,
  waitForUpdateCandidateReadiness,
} from "./update-candidate-canary-readiness.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  canaryOutcomeStep,
  FakeChild,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import * as rehearsals from "./update-candidate-rehearsal.js";
import type { UpdateStepResult } from "./update-step-result.js";

async function listen(server: Server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback HTTP listener");
  }
  return address.port;
}

async function closeServers(...servers: Server[]) {
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

function stubFetch(fn: (url: string, options: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fn);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function deferredProbe() {
  const fetching = createDeferredCore();
  const response = createDeferredCore<Response>();
  return {
    fetching: fetching.promise,
    response,
    fetch: (options?: RequestInit) => {
      options?.signal?.addEventListener("abort", () => response.reject(options.signal?.reason));
      fetching.resolve();
      return response.promise;
    },
  };
}

function waitForProbe(
  probe: Promise<void>,
  validation: ReturnType<typeof validateUpdateCandidateCanary>,
) {
  return Promise.race([
    probe,
    validation.then((result) => {
      throw new Error(`Candidate did not reach probe: ${JSON.stringify(result)}`);
    }),
  ]);
}

export function registerCanaryReadinessBudgetTests(
  root: () => string,
  mocks: {
    spawn: Mock<
      (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => FakeChild
    >;
    snapshot: Mock;
  },
) {
  const validate = (options: Partial<Parameters<typeof validateUpdateCandidateCanary>[0]> = {}) =>
    validateUpdateCandidateCanary({
      root: root(),
      stateDir: root(),
      config: {},
      env: {},
      timeoutMs: 1_000,
      ...options,
    });
  const captureGateway = () => {
    let gateway: FakeChild | undefined;
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args, options) => {
      const child = spawnNormally(command, args, options);
      if (args.includes("--update-canary")) {
        gateway = child;
      }
      return child;
    });
    return () => gateway!;
  };
  const fakeTimersAfterRecovery = (step: UpdateStepResult) => {
    if (step.name === "candidate-recovery") {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
    }
  };
  const progress = async (gateway: () => FakeChild, milestone: string, delay: number) => {
    gateway().stderr.write(`openclaw-update-canary-progress: ${milestone}\n`);
    await vi.advanceTimersByTimeAsync(delay);
  };
  it.each(["late-deadline", "cancelled-sleep"] as const)(
    "preserves uncertain startup warning identity across %s",
    async (ordering) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(0);
      const probe = deferredProbe();
      const receipt = createDeferredCore();
      const sleeping = createDeferredCore();
      const enteredSleep = createDeferredCore();
      const sleep = vi.spyOn(timerPromises, "setTimeout").mockImplementation(() => {
        enteredSleep.resolve();
        return sleeping.promise;
      });
      const caller = new AbortController();
      const uncertain = new CommandProcessCleanupError();
      const cancellation = new Error("caller cancelled during readiness sleep");
      let current = true;
      const startup = observeUpdateCandidateStartup({ env: {}, stateDir: root() });
      const onWarning = vi.fn(() => receipt.promise);
      const fetch = stubFetch(() => probe.fetch());
      const pending = waitForUpdateCandidateReadiness({
        port: 18789,
        workDeadline: 900,
        started: 0,
        signal: caller.signal,
        processExitSignal: new AbortController().signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("candidate authority revoked");
          }
        },
        hasExited: () => false,
        getExitReason: () => undefined,
        startupProgress: startup.milestones,
        onWarning,
        onEndpoint: () => {},
        capture: () => {},
        env: {},
        stateDir: root(),
      });
      const observed = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await probe.fetching;
        await vi.advanceTimersByTimeAsync(300);
        startup.onLine("openclaw-update-canary-progress: config.snapshot");
        if (ordering === "cancelled-sleep") {
          await vi.advanceTimersByTimeAsync(550);
          probe.response.resolve(Response.json({ status: "starting" }, { status: 503 }));
          await enteredSleep.promise;
          expect(sleep).toHaveBeenCalledWith(100, undefined, { signal: caller.signal });
          await vi.advanceTimersByTimeAsync(50);
        } else {
          await vi.advanceTimersByTimeAsync(600);
        }
        expect(onWarning).toHaveBeenCalledOnce();
        receipt.reject(uncertain);
        await vi.advanceTimersByTimeAsync(0);
        if (ordering === "late-deadline") {
          current = false;
          await vi.advanceTimersByTimeAsync(300);
          probe.response.resolve(Response.json({ status: "started" }));
        } else {
          caller.abort(cancellation);
          sleeping.reject(caller.signal.reason);
        }
        const failure = await observed;
        if (ordering === "cancelled-sleep") {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toHaveProperty("cause", cancellation);
          const errors = collectNestedErrorCandidates(failure);
          expect(errors).toContain(cancellation);
          expect(errors).toContain(uncertain);
        } else {
          expect(failure).toBe(uncertain);
        }
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        caller.abort(new Error("readiness test cleanup"));
        probe.response.resolve(Response.json({ status: "started" }));
        receipt.resolve();
        sleeping.resolve();
        await pending.catch(() => undefined);
        await observed;
        sleep.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["write-failed", "authority-revoked"] as const)(
    "joins a startup warning before more probes when %s",
    async (outcome) => {
      const probe = deferredProbe();
      const receipt = createDeferredCore();
      let current = true;
      const gateway = captureGateway();
      const fetch = stubFetch(async (url) =>
        url.endsWith("/startupz") ? probe.fetch() : Response.json({ ready: true }),
      );
      const onProgress = vi.fn((step: { step: string }) => {
        if (step.step === "warning:candidate-gateway-startup") {
          return receipt.promise;
        }
        return undefined;
      });
      const pending = validate({
        assertCurrent: () => {
          if (!current) {
            throw new Error("candidate authority revoked");
          }
        },
        onStep: fakeTimersAfterRecovery,
        onProgress,
      });
      await probe.fetching;
      await vi.advanceTimersByTimeAsync(300);
      await progress(gateway, "config.snapshot", 600);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ step: "warning:candidate-gateway-startup" }),
      );
      probe.response.resolve(Response.json({ status: "started" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/readyz"))).toBe(false);
      if (outcome === "write-failed") {
        receipt.reject(new Error("startup warning storage unavailable"));
      } else {
        current = false;
        receipt.resolve();
      }
      const result = await pending;
      expect(result).toMatchObject({ status: "error", phase: "startup" });
      expect(canaryOutcomeStep(result.steps)?.failureFacts?.[0]?.message).toContain(
        outcome === "write-failed"
          ? "startup warning storage unavailable"
          : "candidate authority revoked",
      );
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/readyz"))).toBe(false);
      expect(gateway().exitCode).toBe(0);
    },
  );

  it.each([
    "ready",
    "stalled",
    "unreachable",
    "readiness-unreachable",
    "exited",
    "spam",
    "ceiling",
  ] as const)("follows completed startup milestones until the candidate is %s", async (outcome) => {
    const startup = deferredProbe();
    const readiness = deferredProbe();
    let startupResponseSent = false;
    const gateway = captureGateway();
    stubFetch(async (url, options) => {
      if (url.endsWith("/readyz")) {
        if (outcome === "readiness-unreachable") {
          return readiness.fetch(options);
        }
        return Response.json({ ready: true });
      }
      if (startupResponseSent) {
        return Response.json({ status: "starting" }, { status: 503 });
      }
      return startup.fetch(options);
    });
    const onProgress = vi.fn();
    const controller = new AbortController();
    const debug = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
    onTestFinished(() => debug.mockRestore());
    const result = validate({
      signal: controller.signal,
      onStep: fakeTimersAfterRecovery,
      onProgress,
    });
    await waitForProbe(startup.fetching, result);
    await vi.advanceTimersByTimeAsync(300);
    await progress(gateway, "config.snapshot", 300);
    await progress(gateway, "plugins.bootstrap", 600);
    if (outcome === "spam" || outcome === "ceiling" || outcome === "ready") {
      for (const [index, milestone] of [
        "runtime.config",
        "runtime.state",
        "gateway.kernel-state",
        "http.bound",
      ].entries()) {
        await progress(
          gateway,
          outcome === "spam" ? `tick.${index}` : milestone,
          index === 3 ? 300 : 600,
        );
      }
      // Readiness at 3.3 s is still inside the independent 3.6 s ceiling.
      if (outcome === "ready") {
        startup.response.resolve(Response.json({ status: "started" }));
      } else {
        await progress(gateway, outcome === "spam" ? "tick.4" : "runtime.post-attach", 300);
        // Bound the negative control too: the old implementation is still waiting here.
        controller.abort(new Error("Test reached the total wait ceiling without a refusal"));
      }
    } else if (outcome === "stalled" || outcome === "unreachable") {
      // Repeating a completed milestone is not forward progress.
      gateway().stderr.write("openclaw-update-canary-progress: plugins.bootstrap\n");
      if (outcome === "stalled") {
        startupResponseSent = true;
        startup.response.resolve(Response.json({ status: "starting" }, { status: 503 }));
      }
      await vi.advanceTimersByTimeAsync(300);
    } else {
      if (outcome === "exited") {
        gateway().stderr.write("[openclaw] Reason: candidate startup failed\n");
        gateway().emit("exit", 78);
      }
      if (outcome === "readiness-unreachable") {
        startup.response.resolve(Response.json({ status: "started" }));
        await waitForProbe(readiness.fetching, result);
        await vi.advanceTimersByTimeAsync(300);
        controller.abort(new Error("Test reached the stall deadline without a refusal"));
      }
    }
    const validation = await result;
    const step = validation.steps.find((entry) => entry.name === "candidate-gateway-startup");
    if (outcome === "ready") {
      expect(validation).toMatchObject({ status: "ok", phase: "readiness" });
      expect(step).toMatchObject({
        exitCode: 0,
        warnings: [expect.stringContaining("still progressing")],
        durationMs: 3_300,
      });
    } else if (outcome === "ceiling") {
      expect(validation.status).toBe("error");
      expect(step?.advisory).toBeUndefined();
      expect(step?.durationMs).toBe(3_600);
      expect(step?.stderrTail).toContain(
        "Candidate still starting after 3.6 s; milestones reached: config.snapshot, plugins.bootstrap, runtime.config, runtime.state, gateway.kernel-state, http.bound, runtime.post-attach",
      );
    } else {
      expect(validation.status).toBe("error");
      expect(step?.stderrTail).toContain(
        outcome === "exited" ? "candidate startup failed" : "stalled",
      );
      expect(step?.durationMs).toBe(outcome === "exited" ? 1_200 : 1_500);
    }
    if (outcome !== "ready" && outcome !== "exited") {
      expect(step).toMatchObject({
        exitCode: null,
        termination: "timeout",
        failureFacts: [
          {
            check: "startupz",
            code: "candidate-startup-failed",
            message: "readiness timeout",
          },
        ],
      });
    }
    if (outcome === "spam") {
      expect(debug).toHaveBeenCalledWith('Ignoring unknown candidate startup milestone: "tick.0"');
      expect(step?.stderrTail).toContain("after plugins.bootstrap");
    }
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "warning:candidate-gateway-startup",
        detail: expect.stringContaining("still progressing"),
      }),
    );
  });

  it.each(["gateway-only", "proxy", "block"] as const)(
    "probes the canary with managed proxy mode %s",
    async (loopbackMode) => {
      const rehearsal = await rehearsals.prepareUpdateCandidateRehearsal({
        candidateRoot: root(),
        stateDir: root(),
        config: {},
        env: {},
      });
      const prepare = vi
        .spyOn(rehearsals, "prepareUpdateCandidateRehearsal")
        .mockResolvedValueOnce(rehearsal);
      const requests: string[] = [];
      const proxyRequests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "started", ready: true }));
      });
      const proxy = createServer((request, response) => {
        proxyRequests.push(request.url ?? "");
        response.writeHead(502);
        response.end();
      });
      proxy.on("connect", (request, socket) => {
        proxyRequests.push(`CONNECT ${request.url}`);
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      const dispatcher = getGlobalDispatcher();
      let handle: ProxyHandle | null = null;
      try {
        await listen(server, rehearsal.port);
        const proxyPort = await listen(proxy);
        vi.stubEnv("no_proxy", "localhost,127.0.0.1,::1");
        handle = await startProxy({
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          loopbackMode,
        });
        const result = await validate();
        if (loopbackMode === "gateway-only") {
          expect(
            result,
            JSON.stringify({ log: result.logTail, requests, proxyRequests }),
          ).toMatchObject({
            status: "ok",
            phase: "readiness",
          });
          expect(requests).toEqual(["/startupz", "/readyz"]);
          expect(proxyRequests).toEqual([]);
          // Default loopback stays direct for the managed proxy's whole lifetime.
          for (const [url, status] of [
            [`http://127.0.0.1:${rehearsal.port}/readyz`, 200],
            ["http://external.example/", 502],
          ] as const) {
            const response = await fetch(url);
            expect(response.status).toBe(status);
            await response.body?.cancel();
          }
          expect(requests).toEqual(["/startupz", "/readyz", "/readyz"]);
          expect(proxyRequests).toEqual(["http://external.example/"]);
        } else if (loopbackMode === "proxy") {
          const message = `Readiness check http://127.0.0.1:${rehearsal.port}/startupz failed: HTTP 502 (via proxy http://127.0.0.1:${proxyPort}). Check Gateway logs and proxy.loopbackMode; rerun openclaw update.`;
          expect(canaryOutcomeStep(result.steps)).toMatchObject({
            name: "candidate-gateway-startup",
            advisory: { kind: "candidate-runtime-unavailable", message },
            failureFacts: [
              {
                check: "startupz",
                code: "candidate-readiness-probe-failed",
                message: expect.stringContaining("failed: HTTP 502"),
              },
            ],
          });
          expect(result.status).toBe("ok");
          expect(requests).toEqual([]);
          expect(proxyRequests.length).toBeGreaterThan(0);
        } else {
          expect(result.status).toBe("error");
          expect(result.logTail.join("\n")).toContain("blocked by proxy.loopbackMode");
          expect(requests).toEqual([]);
          expect(proxyRequests).toEqual([]);
        }
      } finally {
        prepare.mockRestore();
        await stopProxy(handle);
        setGlobalDispatcher(dispatcher);
        vi.unstubAllEnvs();
        await closeServers(server, proxy);
        await rehearsal.cleanup();
      }
    },
  );

  it("records transport causes without turning cancellation into an advisory", async () => {
    const proxy = registerActiveManagedProxyUrl(new URL("http://proxy.example:3128"));
    onTestFinished(() => stopActiveManagedProxyRegistration(proxy));
    const controller = new AbortController();
    stubFetch(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    });
    const params = { timeoutMs: 250 };
    const unavailable = await validate(params);
    expect(unavailable.status).toBe("ok");
    expect(unavailable.logTail.join("\n")).toContain("Update checks reached their time limit");
    expect(canaryOutcomeStep(unavailable.steps)?.advisory?.message).toContain("ECONNREFUSED");
    expect(canaryOutcomeStep(unavailable.steps)?.advisory?.message).not.toContain("via proxy");
    expect(canaryOutcomeStep(unavailable.steps)?.failureFacts).toEqual([
      {
        check: "startupz",
        code: "candidate-readiness-probe-failed",
        message: expect.stringContaining("ECONNREFUSED"),
      },
    ]);
    stubFetch(async () => {
      controller.abort(new Error("operator cancelled"));
      return Response.json({ status: "started" });
    });
    const cancelled = await validate({ ...params, signal: controller.signal });
    expect(cancelled.status).toBe("error");
    expect(canaryOutcomeStep(cancelled.steps)?.advisory).toBeUndefined();
    expect(cancelled.logTail.join("\n")).toContain("operator cancelled");
  });

  it.each([
    ["lint", "candidate-doctor", "candidate-doctor-lint"],
    ["startup", "candidate-recovery", "candidate-gateway-startup"],
    ["config", undefined, "candidate-config"],
  ] as const)(
    "gives %s a fresh budget while retaining its own failures",
    async (phase, previous, name) => {
      stubHealthyGateway();
      let now = 2_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      onTestFinished(() => clock.mockRestore());
      const spawnNormally = mocks.spawn.getMockImplementation()!;
      mocks.spawn.mockImplementation((command, args, options) => {
        const fails = phase === "config" && args.includes("validate");
        if (!args.includes("--fix") && !fails) {
          return spawnNormally(command, args, options);
        }
        const child = new FakeChild(42_000);
        queueMicrotask(() => {
          child.stderr.write(
            fails ? "Configuration unavailable\n" : "Earlier check completed successfully\n",
          );
          now += fails ? 25 : 0;
          child.emit("close", fails ? 1 : 0);
        });
        return child;
      });
      const result = await validate({
        onStep: (step) => {
          now += step.name === previous ? 1_000 : phase === "config" ? 100 : 0;
        },
      });
      if (phase === "config") {
        const failed = canaryOutcomeStep(result.steps);
        expect(result).toMatchObject({ status: "error", phase, durationMs: 425 });
        expect(failed).toMatchObject({ name, durationMs: 25, exitCode: 1 });
        expect(failed?.failureFacts?.[0]?.message).toContain("Configuration unavailable");
        expect(failed?.stderrTail).not.toContain("Earlier check");
      } else {
        expect(result).toMatchObject({ status: "ok", phase: "readiness", durationMs: 1_000 });
        expect(result.steps).toContainEqual(expect.objectContaining({ name, exitCode: 0 }));
        expect(result.logTail.join("\n")).toContain("readyz: ready");
      }
      expect(result.logTail.join("\n")).toContain("Earlier check completed successfully");
    },
  );

  it("reports a runtime inspection failure before preparing a snapshot", async () => {
    const directory = path.join(root(), "dist", "infra");
    await fs.rm(directory, { recursive: true });
    await fs.writeFile(directory, "not a directory");
    const result = await validate({ timeoutMs: 3_000 });
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "candidate-runtime", exitCode: 1 }),
    ]);
    expect(result.steps[0]?.stderrTail).toContain("ENOTDIR");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(
    ["startupz", "readyz"].flatMap((endpoint) =>
      ["headers", "body"].map((delay) => ({ endpoint, delay })),
    ),
  )("allows slow $endpoint $delay within the validation budget", async ({ endpoint, delay }) => {
    const timers = new Set<NodeJS.Timeout>();
    const server = createServer((request, response) => {
      const body = JSON.stringify({ status: "started", ready: true });
      const headers = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      };
      if (request.url !== `/${endpoint}`) {
        headers();
        response.end(body);
        return;
      }
      if (delay === "body") {
        headers();
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (delay === "headers") {
          headers();
        }
        response.end(body);
      }, 1_200);
      timers.add(timer);
      response.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
    const fetchHttp = globalThis.fetch;
    try {
      const port = await listen(server);
      vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
        fetchHttp(`http://127.0.0.1:${port}${new URL(url).pathname}`, options),
      );
      const result = await validate({ timeoutMs: 6_000 });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.logTail.join("\n")).toContain("startupz: started");
      expect(result.logTail.join("\n")).toContain("readyz: ready");
    } finally {
      vi.unstubAllGlobals();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      await closeServers(server);
    }
  });
}
