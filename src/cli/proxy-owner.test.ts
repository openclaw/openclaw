import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { debugProxyHandlers } from "../gateway/server-methods/debug-proxy.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { withProxyCaptureOwner } from "./proxy-capture-owner.js";
import { runDebugProxyRunCommand } from "./proxy-cli.runtime.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";
const { stopServer } = vi.hoisted(() => ({ stopServer: vi.fn(async () => {}) }));
vi.mock("../process/exec-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec-spawn.js")>();
  return {
    ...actual,
    spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) =>
      args[0][0] === "synthetic-child"
        ? Object.assign(Promise.resolve({ exitCode: 0, failed: false }), { kill: vi.fn() })
        : actual.spawnCommand(...args),
  };
});
vi.mock("../proxy-capture/proxy-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxy-capture/proxy-server.js")>()),
  startDebugProxyServer: async ({
    settings,
    captureStore,
  }: {
    settings: { sessionId: string };
    captureStore?: Pick<
      import("../proxy-capture/store.types.js").AsyncDebugProxyCaptureStore,
      "recordEvent"
    >;
  }) => {
    const lease = captureStore ? undefined : await acquireDebugProxyCaptureStoreAsync();
    const store = captureStore ?? lease?.store;
    if (!store) {
      throw new Error("Fixture capture store missing");
    }
    await store.recordEvent({
      sessionId: settings.sessionId,
      ts: 1,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "http",
      direction: "outbound",
      kind: "request",
      flowId: "flow",
      path: "/fixture",
    });
    return {
      proxyUrl: "http://127.0.0.1:7799",
      stop: async () => {
        await stopServer();
        await lease?.release();
      },
    };
  },
}));

const {
  roots,
  startOwner,
  transport: ownerTransport,
} = useLocalStateOwnerFixture(debugProxyHandlers);
beforeEach(() => {
  stopServer.mockReset().mockResolvedValue(undefined);
});
describe("standalone proxy owner routing", () => {
  it("routes standalone proxy session, event and cleanup writes through its owner", async () => {
    await startOwner();
    await runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
    ownerTransport.gatewayContext = true;
    const lease = await acquireDebugProxyCaptureStoreAsync();
    try {
      const sessions = await lease.store.listSessions();
      expect(sessions).toEqual([
        expect.objectContaining({ mode: "proxy-run", endedAt: expect.any(Number), eventCount: 1 }),
      ]);
    } finally {
      await lease.release();
      ownerTransport.gatewayContext = false;
    }
    expect(
      ownerTransport.request.mock.calls.map(([request]) => request.params.command.type),
    ).toEqual(["capture.upsertSession", "capture.recordEvent", "capture.endSession"]);
  });

  it.each(["online", "offline"])("retains %s proxy cleanup through a signal", async (mode) => {
    if (mode === "online") {
      await startOwner();
    }
    const stopping = createDeferred();
    const resume = createDeferred();
    stopServer.mockImplementation(async () => {
      stopping.resolve();
      await resume.promise;
    });
    const command = runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
    await stopping.promise;
    const removeBarrier = registerSignalExitBarrier(async () => {
      const lease = await acquireDebugProxyCaptureStoreAsync();
      try {
        expect(await lease.store.listSessions()).toEqual([
          expect.objectContaining({ endedAt: expect.any(Number), eventCount: 1 }),
        ]);
      } finally {
        await lease.release();
      }
    });
    try {
      const drain = waitForSignalExitBarriers("SIGINT");
      resume.resolve();
      await command;
      await drain;
    } finally {
      resume.resolve();
      removeBarrier();
      await command.catch(() => {});
    }
  });

  it.each(["online", "offline"])(
    "keeps %s child payload capture in the parent owner",
    async (mode) => {
      if (mode === "online") {
        await startOwner();
      }
      const childRoot = roots.make("openclaw-capture-child-");
      const { startDebugProxyServer } = await vi.importActual<
        typeof import("../proxy-capture/proxy-server.js")
      >("../proxy-capture/proxy-server.js");
      const { resolveDebugProxySettings, applyDebugProxyEnv } =
        await import("../proxy-capture/env.js");
      const settings = { ...resolveDebugProxySettings(), sessionId: "parent-session" };
      await withProxyCaptureOwner(async (store) => {
        const server = await startDebugProxyServer({ settings, captureStore: store });
        try {
          const body = {
            type: "capture.recordEvent",
            input: {
              sessionId: settings.sessionId,
              ts: 1,
              sourceScope: "openclaw",
              sourceProcess: "child",
              protocol: "http",
              direction: "outbound",
              kind: "request",
              flowId: "rejected",
            },
          };
          const endpoint = `${server.proxyUrl}/.openclaw/debug-proxy-capture`;
          const captureEndpoint = new URL(server.captureEnv.OPENCLAW_DEBUG_PROXY_URL);
          const token = captureEndpoint.password;
          for (const [authorization, command] of [
            ["Bearer wrong", body],
            [`Bearer ${token}`, { ...body, input: { ...body.input, sessionId: "other-session" } }],
            [`Bearer ${token}`, { type: "capture.purgeAll" }],
          ] as const) {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { authorization },
              body: JSON.stringify(command),
            });
            expect(response.ok).toBe(false);
          }
          expect(await store.listSessions()).toEqual([]);
          const entrypoint = resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl({
              currentModuleUrl: import.meta.url,
              sourceWorkerName: "../proxy-capture/child-transport.process.test-support",
              distWorkerPath: "proxy-capture/child-transport.process.test-support.js",
            }),
          );
          const childEnv = applyDebugProxyEnv(
            {
              PATH: process.env.PATH,
              HOME: childRoot,
              USERPROFILE: childRoot,
              SystemRoot: process.env.SystemRoot,
              OPENCLAW_STATE_DIR: childRoot,
            },
            {
              proxyUrl: server.proxyUrl,
              sessionId: settings.sessionId,
              certDir: settings.certDir,
            },
          );
          Object.assign(childEnv, server.captureEnv);
          expect(resolveDebugProxySettings(childEnv).proxyUrl).toBe(server.proxyUrl);
          expect(childEnv.HTTP_PROXY).toBe(server.proxyUrl);
          expect(childEnv.HTTPS_PROXY).toBe(server.proxyUrl);
          expect(childEnv.ALL_PROXY).toBe(server.proxyUrl);
          const invalidEndpoint = new URL(captureEndpoint);
          invalidEndpoint.password = mode === "online" ? "invalid-fixture-token" : "";
          await expect(
            promisify(execFile)(process.execPath, entrypoint, {
              env: {
                ...childEnv,
                OPENCLAW_DEBUG_PROXY_URL: invalidEndpoint.toString(),
              },
            }),
          ).rejects.toThrow(/refused capture|credentials are missing/);
          await expect(
            fs.stat(path.join(childRoot, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const upstream = vi.fn();
          const origin = createServer((req, res) => {
            upstream(req.headers);
            res.end("upstream response");
          });
          await new Promise<void>((resolve) => {
            origin.listen(0, "127.0.0.1", resolve);
          });
          const address = origin.address();
          if (!address || typeof address === "string") {
            throw new Error("Fixture origin address unavailable");
          }
          try {
            await promisify(execFile)(
              process.execPath,
              [...entrypoint, `http://127.0.0.1:${address.port}/upstream`],
              { env: childEnv },
            );
            expect(upstream).toHaveBeenCalledOnce();
            expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("authorization");
            expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("proxy-authorization");
            expect(JSON.stringify(upstream.mock.calls)).not.toContain(token);
          } finally {
            await new Promise<void>((resolve) => {
              origin.close(() => resolve());
            });
          }
          expect(await store.listSessions()).toEqual([
            expect.objectContaining({
              id: settings.sessionId,
              eventCount: 3,
              endedAt: expect.any(Number),
              proxyUrl: server.proxyUrl,
            }),
          ]);
          expect(JSON.stringify(await store.listSessions())).not.toContain(token);
          await expect(
            fs.stat(path.join(childRoot, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          if (mode === "online") {
            expect(
              ownerTransport.request.mock.calls.map(([request]) => request.params.command?.type),
            ).toContain("capture.recordEventWithPayload");
          }
        } finally {
          await server.stop();
        }
      });
    },
  );
});
