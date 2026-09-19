import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { startProxy, stopProxy, type ProxyHandle } from "./net/proxy/proxy-lifecycle.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { FakeChild } from "./update-candidate-canary.test-support.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export function expectCanaryReadinessWarning(
  step: UpdateStepResult | undefined,
  check: string,
  status: number,
) {
  expect(step).toMatchObject({
    name: "Checking Gateway startup",
    advisory: {
      kind: "candidate-runtime-unavailable",
      message: expect.stringContaining(`failed: HTTP ${status}`),
    },
    failureFacts: [
      {
        check,
        code: "candidate-readiness-probe-failed",
        message: expect.stringContaining(`failed: HTTP ${status}`),
      },
    ],
  });
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
  it.each(["gateway-only", "proxy", "block"] as const)(
    "probes the canary with managed proxy mode %s",
    async (loopbackMode) => {
      const rehearsal = await prepareUpdateCandidateRehearsal({
        candidateRoot: root(),
        stateDir: root(),
        config: {},
        env: {},
      });
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
        server.listen(rehearsal.port, "127.0.0.1");
        await once(server, "listening");
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const address = proxy.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected a loopback proxy listener");
        }
        vi.stubEnv("no_proxy", "localhost,127.0.0.1,::1");
        handle = await startProxy({
          proxyUrl: `http://127.0.0.1:${address.port}`,
          loopbackMode,
        });
        const result = await validateUpdateCandidateCanary({
          root: root(),
          stateDir: root(),
          config: {},
          env: {},
          rehearsal,
          timeoutMs: 1_000,
        });
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
          // The canary releases its exception; unrelated traffic still uses the proxy.
          for (const url of [
            `http://127.0.0.1:${rehearsal.port}/readyz`,
            "http://external.example/",
          ]) {
            const response = await fetch(url);
            expect(response.status).toBe(502);
            await response.body?.cancel();
          }
        } else if (loopbackMode === "proxy") {
          const message = `Readiness probe http://127.0.0.1:${rehearsal.port}/startupz failed: HTTP 502 (via proxy http://127.0.0.1:${address.port}). Check Gateway logs and proxy.loopbackMode; rerun openclaw update.`;
          expectCanaryReadinessWarning(result.steps.at(-1), "startupz", 502);
          expect(result.steps.at(-1)).toMatchObject({
            advisory: { kind: "candidate-runtime-unavailable", message },
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
        await stopProxy(handle);
        setGlobalDispatcher(dispatcher);
        vi.unstubAllEnvs();
        for (const listener of [server, proxy]) {
          listener.closeAllConnections();
          if (listener.listening) {
            await new Promise<void>((resolve, reject) => {
              listener.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
        await rehearsal.cleanup();
      }
    },
  );

  it("records transport causes without turning cancellation into an advisory", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      }),
    );
    const params = { root: root(), stateDir: root(), config: {}, env: {}, timeoutMs: 250 };
    const unavailable = await validateUpdateCandidateCanary(params);
    expect(unavailable.status).toBe("ok");
    expect(unavailable.logTail.join("\n")).toContain("Update checks reached their time limit");
    expect(unavailable.steps.at(-1)?.advisory?.message).toContain("ECONNREFUSED");
    expect(unavailable.steps.at(-1)?.failureFacts).toEqual([
      {
        check: "startupz",
        code: "candidate-readiness-probe-failed",
        message: expect.stringContaining("ECONNREFUSED"),
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort(new Error("operator cancelled"));
        return Response.json({ status: "started" });
      }),
    );
    const cancelled = await validateUpdateCandidateCanary({ ...params, signal: controller.signal });
    expect(cancelled.status).toBe("error");
    expect(cancelled.steps.at(-1)?.advisory).toBeUndefined();
    expect(cancelled.logTail.join("\n")).toContain("operator cancelled");
  });

  it.each([
    ["lint", "Checking data migrations", "Checking update health"],
    ["startup", "Checking update recovery", "Checking Gateway startup"],
    ["config", undefined, "Checking configuration"],
  ] as const)("attributes %s failures to their check", async (phase, previous, name) => {
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
    const result = await validateUpdateCandidateCanary({
      root: root(),
      stateDir: root(),
      config: {},
      env: {},
      timeoutMs: 1_000,
      onStep: (step) => {
        now += step.name === previous ? 1_000 : phase === "config" ? 100 : 0;
      },
    });
    const failed = result.steps.at(-1);
    const durationMs = phase === "config" ? 25 : 0;
    expect(result).toMatchObject({ status: "error", phase });
    expect(result.durationMs).toBe(phase === "config" ? 425 : 1_000);
    expect(failed).toMatchObject({ name, durationMs, exitCode: 1 });
    expect(failed?.failureFacts?.[0]?.message).toContain(
      phase === "config" ? "Configuration unavailable" : "deadline exceeded",
    );
    expect(failed?.stderrTail).not.toContain("Earlier check");
    expect(result.logTail.join("\n")).toContain("Earlier check completed successfully");
  });

  it("reports a runtime inspection failure before preparing a snapshot", async () => {
    const directory = path.join(root(), "dist", "infra");
    await fs.rm(directory, { recursive: true });
    await fs.writeFile(directory, "not a directory");
    const result = await validateUpdateCandidateCanary({
      root: root(),
      stateDir: root(),
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "Checking update runtime", exitCode: 1 }),
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
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback HTTP listener");
      }
      vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
        fetchHttp(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options),
      );
      const result = await validateUpdateCandidateCanary({
        root: root(),
        stateDir: root(),
        config: {},
        env: {},
        timeoutMs: 6_000,
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.logTail.join("\n")).toContain("startupz: started");
      expect(result.logTail.join("\n")).toContain("readyz: ready");
    } finally {
      vi.unstubAllGlobals();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
}
