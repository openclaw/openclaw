import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { debugProxyHandlers } from "../gateway/server-methods/debug-proxy.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import type { CaptureEventRecord } from "../proxy-capture/types.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { withProxyCaptureOwner } from "./proxy-capture-owner.js";
import { runDebugProxyRunCommand } from "./proxy-cli.runtime.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";
const { stopServer } = vi.hoisted(() => ({ stopServer: vi.fn(async () => {}) }));
function captureEvent(
  sessionId: string,
  sourceProcess: string,
  flowId: string,
): CaptureEventRecord {
  return {
    sessionId,
    sourceProcess,
    flowId,
    ts: 1,
    sourceScope: "openclaw",
    protocol: "http",
    direction: "outbound",
    kind: "request",
  };
}
async function readSessions() {
  const lease = await acquireDebugProxyCaptureStoreAsync();
  try {
    return await lease.store.listSessions();
  } finally {
    await lease.release();
  }
}
const endedSession = (details: Record<string, unknown>) => [
  expect.objectContaining({ endedAt: expect.any(Number), ...details }),
];
const runProxy = () => runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
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
  }: Parameters<typeof import("../proxy-capture/proxy-server.js").startDebugProxyServer>[0]) => {
    if (!captureStore) {
      throw new Error("Expected parent-owned capture store");
    }
    await captureStore.recordEvent({
      ...captureEvent(settings.sessionId, "openclaw", "flow"),
      path: "/fixture",
    });
    return {
      proxyUrl: "http://127.0.0.1:7799",
      stop: stopServer,
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
  const command = runProxy();
  await stopping.promise;
  const removeBarrier = registerSignalExitBarrier(async () => {
    expect(await readSessions()).toEqual(endedSession({ mode: "proxy-run", eventCount: 1 }));
  });
  try {
    const drain = waitForSignalExitBarriers("SIGINT");
    resume.resolve();
    await command;
    await drain;
    if (mode === "online") {
      expect(
        ownerTransport.request.mock.calls.map(([request]) => request.params.command.type),
      ).toEqual(["capture.upsertSession", "capture.recordEvent", "capture.endSession"]);
    }
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
          input: captureEvent(settings.sessionId, "child", "rejected"),
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
        const runChild = (env = childEnv, ...args: string[]) =>
          promisify(execFile)(process.execPath, [...entrypoint, ...args], { env });
        const expectNoChildDatabase = () =>
          expect(fs.stat(path.join(childRoot, "state", "openclaw.sqlite"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        expect(resolveDebugProxySettings(childEnv).proxyUrl).toBe(server.proxyUrl);
        expect(childEnv).toMatchObject({
          HTTP_PROXY: server.proxyUrl,
          HTTPS_PROXY: server.proxyUrl,
          ALL_PROXY: server.proxyUrl,
        });
        const invalidEndpoint = new URL(captureEndpoint);
        invalidEndpoint.password = mode === "online" ? "invalid-fixture-token" : "";
        await expect(
          runChild({
            ...childEnv,
            OPENCLAW_DEBUG_PROXY_URL: invalidEndpoint.toString(),
          }),
        ).rejects.toThrow(/refused capture|credentials are missing/);
        await expectNoChildDatabase();
        const upstream = vi.fn();
        const origin = createServer((req, res) => {
          upstream(req.headers);
          res.end("upstream response");
        });
        const originUrl = await listenLoopback(origin);
        try {
          await runChild(childEnv, `${originUrl}/upstream`);
          expect(upstream).toHaveBeenCalledOnce();
          expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("authorization");
          expect(upstream.mock.calls[0]?.[0]).not.toHaveProperty("proxy-authorization");
          expect(JSON.stringify(upstream.mock.calls)).not.toContain(token);
        } finally {
          await closeHttpServer(origin);
        }
        const sessions = await store.listSessions();
        expect(sessions).toEqual(
          endedSession({
            id: settings.sessionId,
            eventCount: 3,
            proxyUrl: server.proxyUrl,
          }),
        );
        expect(JSON.stringify(sessions)).not.toContain(token);
        await expectNoChildDatabase();
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
