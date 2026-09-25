import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createGatewayPortalService } from "../gateway/portals/portal-service.js";
import { prepareTailscalePublishedOrigin } from "../gateway/tailscale-published-origin.js";

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

import { claimTailscaleRoute, claimTailscaleServePort } from "./tailscale.js";

// Gate worker readiness and exit explicitly: no subprocesses or live daemon writes.
function queueOwner(options: { ready?: boolean; stop?: boolean; failure?: string } = {}) {
  const started = createDeferred();
  const stopped = createDeferred();
  const owner = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(() => {
      stopped.resolve();
      if (options.stop !== false) {
        queueMicrotask(() => owner.emit("exit", 0, null));
      }
    }),
    kill: vi.fn(() => owner.emit("exit", 0, "SIGTERM")),
  });
  forkMock.mockImplementationOnce(() => {
    started.resolve();
    queueMicrotask(() => {
      if (options.failure) {
        owner.emit("message", {
          type: "failed",
          code: 1,
          stdout: "",
          stderr: options.failure,
        });
      } else if (options.ready !== false) {
        owner.emit("message", { type: "ready" });
      }
    });
    return owner;
  });
  return { owner, started: started.promise, stopped: stopped.promise };
}

const legacyRoutes = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "18790": { HTTPS: true } },
  Web: {
    "fixture.tailnet.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
    },
    "fixture.tailnet.ts.net:18790": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:18790" } },
    },
  },
});

beforeEach(() => {
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("OPENCLAW_TEST_TAILSCALE_BINARY", "tailscale");
  runExecMock.mockImplementation(async (_bin: string, args: string[]) => ({
    stdout: args[0] === "status" ? '{"BackendState":"Running"}' : legacyRoutes,
    stderr: "",
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("private Tailscale Serve claims", () => {
  it.for([
    { boundary: "queue", revoke: true },
    { boundary: "queue", revoke: false },
    { boundary: "status", revoke: true },
    { boundary: "status", revoke: false },
  ] as const)(
    "checks authority after $boundary wait (revoked: $revoke)",
    async ({ boundary, revoke }) => {
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      const previousOwner = boundary === "queue" ? queueOwner({ ready: false }) : undefined;
      const previous = previousOwner
        ? claimTailscaleRoute("serve", 19000, 18789, vi.fn())
        : undefined;
      await previousOwner?.started;
      const previousForks = forkMock.mock.calls.length;
      if (boundary === "status") {
        runExecMock.mockImplementation(async (_bin: string, args: string[]) => {
          if (args[0] === "serve" && args[1] === "status") {
            readStarted.resolve();
            await releaseRead.promise;
          }
          return {
            stdout: args[0] === "status" ? '{"BackendState":"Running"}' : legacyRoutes,
            stderr: "",
          };
        });
      }
      queueOwner();
      let current = true;
      const denied = new Error("permission denied: caller authority expired");
      const starting = claimTailscaleServePort(19001, 24443, () => {
        if (!current) {
          throw denied;
        }
      });
      if (boundary === "status") {
        await readStarted.promise;
      }
      current = !revoke;
      releaseRead.resolve();
      previousOwner?.owner.emit("message", { type: "ready" });
      const settled = await starting.then(
        (claim) => ({ claim }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(forkMock).toHaveBeenCalledTimes(previousForks + (revoke ? 0 : 1));
        if (revoke) {
          expect(settled).toEqual({ error: denied });
        } else {
          expect("claim" in settled && settled.claim.isActive()).toBe(true);
        }
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
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      runExecMock.mockImplementation(async (_bin: string, args: string[]) => {
        if (args[0] === "serve" && args[1] === "status") {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return {
          stdout: args[0] === "status" ? '{"BackendState":"Running"}' : legacyRoutes,
          stderr: "",
        };
      });
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
      await readStarted.promise;
      const listeners = [...httpServers];
      let closing: Promise<void> | undefined;
      if (owner === "caller") {
        current = false;
      } else if (owner === "gateway") {
        withdraw();
      } else {
        closing = service.closeAll();
      }
      releaseRead.resolve();
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

  it("claims an explicit private port without adopting even a matching legacy backend", async () => {
    const { owner } = queueOwner();
    const claim = await claimTailscaleServePort(18789, 24443, () => {});

    expect(forkMock.mock.calls[0]?.[1]).toEqual([
      "--openclaw-tailscale-route-owner",
      JSON.stringify({
        argv: ["tailscale", "serve", "--yes", "--bg=false", "--https=24443", "18789"],
      }),
    ]);
    expect(forkMock.mock.calls[0]?.[2]).toMatchObject({
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    expect(runExecMock.mock.calls.map((call) => call[1])).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
    expect(claim.isActive()).toBe(true);
    await Promise.all([claim.stop(), claim.stop()]);
    await expect(claim.exited).resolves.toBeUndefined();
    expect(claim.isActive()).toBe(false);
    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(owner.send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
    expect(runExecMock).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid HTTPS port %s before daemon access",
    async (port) => {
      await expect(claimTailscaleServePort(18789, port, () => {})).rejects.toThrow(/httpsPort/);
      expect(runExecMock).not.toHaveBeenCalled();
      expect(forkMock).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 65536, 1.5, Number.NaN])("rejects invalid backend port %s", async (port) => {
    await expect(claimTailscaleServePort(port, 24443, () => {})).rejects.toThrow(/target/);
    expect(runExecMock).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it.each([1, 65535])("accepts bounded HTTPS port %s", async (port) => {
    queueOwner();
    const claim = await claimTailscaleServePort(18789, port, () => {});
    await claim.stop();
  });

  it("withdraws activity when the owned worker exits unexpectedly", async () => {
    const { owner } = queueOwner();
    const claim = await claimTailscaleServePort(18789, 24443, () => {});
    owner.emit("exit", 1, null);
    await claim.exited;
    expect(claim.isActive()).toBe(false);
  });

  it("keeps explicit private arguments and operator diagnostics on permission fallback", async () => {
    queueOwner({ failure: "permission denied" });
    queueOwner({ failure: "sudo: a password is required" });
    await expect(claimTailscaleServePort(18789, 24443, () => {})).rejects.toThrow(
      /Tailscale serve needs elevated access[\s\S]*sudo tailscale set --operator=\$USER/,
    );
    expect(forkMock.mock.calls[1]?.[1]).toEqual([
      "--openclaw-tailscale-route-owner",
      JSON.stringify({
        argv: ["sudo", "-n", "tailscale", "serve", "--yes", "--bg=false", "--https=24443", "18789"],
      }),
    ]);
    expect(runExecMock.mock.calls.every((call) => !call[1].includes("off"))).toBe(true);
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
    first.owner.emit("exit", 0, null);
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
