import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayPortalService } from "../gateway/portals/portal-service.js";
import { startGatewayTailscaleExposure } from "../gateway/server-tailscale.js";
import {
  getTailscalePublishedOrigin,
  prepareTailscalePublishedOrigin,
} from "../gateway/tailscale-published-origin.js";

const { forkMock, runExecMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  runExecMock: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: forkMock,
}));
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));
vi.mock("./runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/tailscale-route-owner.mjs"),
}));

import { claimTailscaleRoute, claimTailscaleServePort, findTailscaleBinary } from "./tailscale.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const serveDenied = "Serve is not enabled on your tailnet.";
const retirementFailed = "route termination was not confirmed";
const daemonLost = "\nlost connection to tailscaled: EOF";

function startExposure(
  tailscaleMode: "serve" | "funnel" = "serve",
  logTailscale = { info: vi.fn(), warn: vi.fn() },
  signal?: AbortSignal,
) {
  return startGatewayTailscaleExposure({
    tailscaleMode,
    port: 18789,
    backend: { port: 19000, host: "127.0.0.1" },
    logTailscale,
    signal,
  });
}

function statusReply(args: string[]) {
  return { stdout: args[0] === "status" ? '{"BackendState":"Running"}' : legacyRoutes, stderr: "" };
}

function pauseStatusRead() {
  const started = createDeferred();
  const release = createDeferred();
  runExecMock.mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === "serve" && args[1] === "status") {
      started.resolve();
      await release.promise;
    }
    return statusReply(args);
  });
  return { started: started.promise, release: () => release.resolve() };
}

function installPathBinary(prefix: string) {
  const binary = path.join(tempDirs.make(prefix), "tailscale");
  fs.writeFileSync(binary, "", { mode: 0o755 });
  vi.stubEnv("PATH", path.dirname(binary));
  return binary;
}

// Gate worker readiness and exit explicitly: no subprocesses or live daemon writes.
function queueOwner(
  options: {
    ready?: boolean;
    stop?: boolean;
    failure?: string;
    code?: number | null;
    stopFailure?: string;
    stdout?: string;
    failureAfterStop?: string;
    abortOnStop?: () => void;
  } = {},
) {
  const started = createDeferred();
  const stopped = createDeferred();
  const exitOwner = (code: number, signal: NodeJS.Signals | null) => {
    owner.emit("exit", code, signal);
    owner.emit("close", code, signal);
  };
  const fail = (code: number | null, stdout = "", stderr = "", signal?: string) =>
    owner.emit("message", { type: "failed", code, stdout, stderr, signal });
  const owner = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(() => {
      stopped.resolve();
      options.abortOnStop?.();
      if (options.failureAfterStop) {
        fail(null, options.failureAfterStop, "", "SIGTERM");
      }
      if (options.stopFailure) {
        owner.emit("message", { type: "stop-failed", message: options.stopFailure });
      }
      if (options.stop !== false) {
        queueMicrotask(() => exitOwner(0, null));
      }
    }),
    kill: vi.fn(() => exitOwner(0, "SIGTERM")),
  });
  forkMock.mockImplementationOnce(() => {
    started.resolve();
    queueMicrotask(() => {
      if (options.failure || options.stdout) {
        fail(options.code === undefined ? 1 : options.code, options.stdout, options.failure);
      } else if (options.ready !== false) {
        owner.emit("message", { type: "ready" });
      }
    });
    return owner;
  });
  return { owner, exit: exitOwner, started: started.promise, stopped: stopped.promise };
}

const proxyRoute = (port: number) => ({ Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } });
const legacyRoutes = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "18790": { HTTPS: true } },
  Web: {
    "fixture.tailnet.ts.net:443": proxyRoute(18789),
    "fixture.tailnet.ts.net:18790": proxyRoute(18790),
  },
});

beforeEach(() => {
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("OPENCLAW_TEST_TAILSCALE_BINARY", "tailscale");
  runExecMock.mockImplementation(async (_bin: string, args: string[]) => statusReply(args));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("private Tailscale Serve claims", () => {
  it.each([
    { code: 0, prefix: "To enable, visit:\n" },
    { code: 0, prefix: "" },
    { code: 1, prefix: "To enable, visit:\n" },
  ])(
    "keeps local Gateway availability after a confirmed Serve denial (code $code, prefix '$prefix')",
    async ({ code, prefix }) => {
      const denial = `Serve is not enabled on your tailnet.\n${prefix}\nhttps://example.test/serve`;
      const pending = queueOwner({
        code,
        ...(code === 0 ? { stdout: denial } : { failure: denial }),
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const cleanup = await startExposure("serve", log);
      expect(cleanup).toBeNull();
      expect(pending.owner.send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
      expect(getTailscalePublishedOrigin()).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringMatching(/local.*Gateway.*available.*tailnet/s),
      );
    },
  );

  it.each([
    ["funnel", 1, serveDenied],
    ["serve", null, serveDenied],
    ["serve", 1, `Unexpected proxy error: ${serveDenied}`],
    ["serve", 1, "permission denied"],
    ["serve", 1, `${serveDenied}\nTo enable, visit:\nhttps://example.test/serve${daemonLost}`],
  ] as const)("keeps %s command failure fatal (code %s): %s", async (mode, code, failure) => {
    const options = { code, failure };
    queueOwner(options);
    if (failure === "permission denied") {
      queueOwner(options);
    }
    await expect(startExposure(mode)).rejects.toThrow(failure);
    expect(getTailscalePublishedOrigin()).toBeUndefined();
  });

  it.each([
    ["policy denial", "serve", "local", "", undefined],
    ["Funnel denial", "funnel", "fatal", "", undefined],
    ["later daemon failure", "serve", "fatal", daemonLost, undefined],
    ["failed retirement", "serve", "fatal", "", retirementFailed],
    ["shutdown during retirement", "serve", "cancelled", "", undefined],
  ] as const)(
    "joins the owned startup deadline at %s",
    async (_boundary, mode, expected, extra, cleanup) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const interrupted = new Error("Gateway stopped while retiring denied Serve");
      const pending = queueOwner({
        ready: false,
        failureAfterStop: `${serveDenied}\nTo enable, visit:\nhttps://example.test/serve${extra}`,
        stopFailure: cleanup,
        ...(expected === "cancelled" ? { abortOnStop: () => controller.abort(interrupted) } : {}),
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const result = startExposure(mode, log, controller.signal).catch((error: unknown) => error);
      await pending.started;
      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await result;
      if (expected === "local") {
        expect(outcome).toBeNull();
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining("local Gateway remains available"),
        );
      } else if (expected === "cancelled") {
        expect(outcome).toBe(interrupted);
      } else {
        expect(outcome).toBeInstanceOf(Error);
        if (cleanup) {
          expect(outcome).toBeInstanceOf(AggregateError);
          const failure = outcome as AggregateError;
          expect(failure.errors.map((cause: Error) => cause.message)).toEqual([
            serveDenied,
            retirementFailed,
          ]);
          expect(failure.cause).toBe(failure.errors[1]);
        }
      }
      expect(getTailscalePublishedOrigin()).toBeUndefined();
    },
  );

  it("keeps stopped-daemon ingress closed and claims normally after the connection returns", async () => {
    runExecMock.mockResolvedValueOnce({ stdout: '{"BackendState":"Stopped"}' });
    await expect(claimTailscaleRoute("serve", 19000, 18789, vi.fn())).rejects.toMatchObject({
      code: "gateway.tailscale_backend_stopped",
    });
    expect(forkMock).not.toHaveBeenCalled();
    expect(runExecMock).toHaveBeenCalledTimes(1);
    queueOwner();
    const claim = await claimTailscaleRoute("serve", 19000, 18789, vi.fn());
    expect(claim.isActive()).toBe(true);
    await claim.stop();
  });

  it("joins a cancelled Gateway claim even when readiness races shutdown", async () => {
    const pending = queueOwner({ ready: false });
    const controller = new AbortController();
    const interrupted = new Error("Gateway stopped during startup");
    const starting = claimTailscaleRoute("serve", 19000, 18789, vi.fn(), controller.signal);
    await pending.started;
    controller.abort(interrupted);
    pending.owner.emit("message", { type: "ready" });
    await expect(starting).rejects.toBe(interrupted);
    expect(pending.owner.send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
  });

  it.each(["queue", "status"] as const)(
    "checks revoked authority after %s wait",
    async (boundary) => {
      const previousOwner = boundary === "queue" ? queueOwner({ ready: false }) : undefined;
      const previous = previousOwner
        ? claimTailscaleRoute("serve", 19000, 18789, vi.fn())
        : undefined;
      await previousOwner?.started;
      const previousForks = forkMock.mock.calls.length;
      const read = boundary === "status" ? pauseStatusRead() : undefined;
      queueOwner();
      let current = true;
      const denied = new Error("permission denied: caller authority expired");
      const starting = claimTailscaleServePort(19001, 24443, () => {
        if (!current) {
          throw denied;
        }
      });
      if (read) {
        await read.started;
      }
      current = false;
      read?.release();
      previousOwner?.owner.emit("message", { type: "ready" });
      const settled = await starting.then(
        (claim) => ({ claim }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(forkMock).toHaveBeenCalledTimes(previousForks);
        expect(settled).toEqual({ error: denied });
        expect(runExecMock.mock.calls.some(([bin]) => bin === "sudo")).toBe(false);
      } finally {
        if ("claim" in settled) {
          await settled.claim.stop();
        }
        await (await previous)?.stop();
      }
    },
  );

  it.each(["caller", "gateway", "service"] as const)(
    "does not create a portal route after %s authority closes during status discovery",
    async (owner) => {
      const read = pauseStatusRead();
      queueOwner();
      const withdraw = prepareTailscalePublishedOrigin({
        origin: "https://fixture.tailnet.ts.net",
        mode: "serve",
      });
      const httpServers: import("node:http").Server[] = [];
      const service = createGatewayPortalService({
        managedTailscale: true,
        httpBindHosts: ["127.0.0.1"],
        httpServers,
      });
      let current = true;
      const releaseTarget = vi.fn();
      const opening = service.open({
        targetPort: 3000,
        assertCurrent: () => {
          if (!current) {
            throw new Error("caller authority expired");
          }
        },
        onClose: releaseTarget,
      });
      const rejected = expect(opening).rejects.toThrow();
      await read.started;
      const listeners = [...httpServers];
      let closing: Promise<void> | undefined;
      if (owner === "caller") {
        current = false;
      } else if (owner === "gateway") {
        withdraw();
      } else {
        closing = service.closeAll();
      }
      read.release();
      try {
        await rejected;
        await closing;
        expect(forkMock).not.toHaveBeenCalled();
        expect(service.list()).toEqual([]);
        expect(httpServers).toEqual([]);
        expect(listeners.every((server) => !server.listening)).toBe(true);
        expect(releaseTarget).toHaveBeenCalledOnce();
      } finally {
        withdraw();
        await service.closeAll();
      }
    },
  );

  it.each([
    { port: 65535, ending: "stop" },
    { port: 24443, ending: "unexpected exit" },
  ])(
    "owns private port $port through $ending without adopting legacy routes",
    async ({ port, ending }) => {
      const { owner, exit } = queueOwner();
      const claim = await claimTailscaleServePort(18789, port, () => {});

      expect(forkMock.mock.calls[0]?.[1]).toEqual([
        "--openclaw-tailscale-route-owner",
        JSON.stringify({
          argv: ["tailscale", "serve", "--yes", "--bg=false", `--https=${port}`, "18789"],
        }),
      ]);
      expect(forkMock.mock.calls[0]?.[2]).toMatchObject({
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      expect(runExecMock.mock.calls.map((call) => call[1])).toEqual([
        ["status", "--json"],
        ["serve", "status", "--json"],
      ]);
      expect(claim.isActive()).toBe(true);
      if (ending === "stop") {
        await Promise.all([claim.stop(), claim.stop()]);
        expect(owner.send).toHaveBeenCalledTimes(1);
        expect(owner.send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
      } else {
        exit(1, null);
      }
      await expect(claim.exited).resolves.toBeUndefined();
      expect(claim.isActive()).toBe(false);
      expect(runExecMock).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects an invalid HTTPS port before daemon access", async () => {
    await expect(claimTailscaleServePort(18789, 65536, () => {})).rejects.toThrow("httpsPort");
    expect(runExecMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it("reports an occupied port without retrying or clearing it, then allows the next claim", async () => {
    queueOwner({ failure: "listener already exists for port 18790" });
    queueOwner();
    const failure = claimTailscaleServePort(18789, 18790, () => {});
    const next = claimTailscaleServePort(18789, 24443, () => {});
    await expect(failure).rejects.toThrow(/ownership OpenClaw cannot prove; it was not modified/);
    const claim = await next;
    await claim.stop();
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(runExecMock.mock.calls.every((call) => !call[1].includes("off"))).toBe(true);
  });

  it.each(["gateway-first", "portal-first"] as const)(
    "serializes Gateway and portal startup through readiness (%s)",
    async (order) => {
      const first = queueOwner({ ready: false });
      const second = queueOwner({ ready: false });
      const gateway = () => claimTailscaleRoute("serve", 19000, 18789, vi.fn());
      const portal = () => claimTailscaleServePort(19001, 24443, () => {});
      const firstClaim = order === "gateway-first" ? gateway() : portal();
      const secondClaim = order === "gateway-first" ? portal() : gateway();
      await first.started;
      expect(forkMock).toHaveBeenCalledTimes(1);
      first.owner.emit("message", { type: "ready" });
      await second.started;
      const claimA = await firstClaim;
      expect(claimA.isActive()).toBe(true);
      second.owner.emit("message", { type: "ready" });
      const claimB = await secondClaim;
      expect(runExecMock.mock.calls.filter((call) => call[1].includes("off"))).toHaveLength(1);
      await Promise.all([claimA.stop(), claimB.stop()]);
    },
  );

  it("waits for an owned stop to finish before starting another claim", async () => {
    const first = queueOwner({ stop: false });
    queueOwner();
    const claimA = await claimTailscaleServePort(19000, 24443, () => {});
    const stopping = claimA.stop();
    const starting = claimTailscaleRoute("serve", 19001, 18789, vi.fn());
    await first.stopped;
    expect(forkMock).toHaveBeenCalledTimes(1);
    first.exit(0, null);
    await stopping;
    const claimB = await starting;
    await claimB.stop();
  });

  it("does not stop a sibling while another claim is reading and publishing config", async () => {
    const first = queueOwner();
    const second = queueOwner({ ready: false });
    const claimA = await claimTailscaleRoute("serve", 19000, 18789, vi.fn());
    const starting = claimTailscaleServePort(19001, 24443, () => {});
    await second.started;
    const stopping = claimA.stop();
    await Promise.resolve();
    expect(first.owner.send).not.toHaveBeenCalled();
    second.owner.emit("message", { type: "ready" });
    const claimB = await starting;
    await stopping;
    expect(claimB.isActive()).toBe(true);
    await claimB.stop();
  });
});

describe("findTailscaleBinary", () => {
  it("finds the PATH executable without spawning which and keeps CLI validation", async () => {
    const binary = installPathBinary("openclaw-tailscale-discovery-");
    runExecMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === "which") {
        return { stdout: `${binary}\n`, stderr: "" };
      }
      if (command === binary && args[0] === "version") {
        return { stdout: "1.94.0\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(findTailscaleBinary()).resolves.toBe(binary);
    expect(runExecMock).toHaveBeenCalledExactlyOnceWith(binary, ["version"], { timeoutMs: 3000 });
  });

  it("rejects a PATH candidate whose version command fails", async () => {
    const binary = installPathBinary("openclaw-tailscale-invalid-");
    runExecMock.mockImplementation(async (command: string) => {
      if (command === "locate") {
        return { stdout: "", stderr: "" };
      }
      throw new Error("CLI cannot run");
    });

    await expect(findTailscaleBinary()).resolves.toBeNull();
    expect(runExecMock).toHaveBeenCalledWith(binary, ["version"], { timeoutMs: 3000 });
    expect(runExecMock.mock.calls.some(([command]) => command === "which")).toBe(false);
  });
});
