import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import workboard from "../../extensions/workboard/index.js";
import { registerWorkboardGatewayMethods } from "../../extensions/workboard/runtime-api.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { debugProxyHandlers } from "../gateway/server-methods/debug-proxy.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "../gateway/server-methods/sessions-mutations.owner.test-support.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import {
  acquireGatewayLock,
  readActiveGatewayLockIdentity,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withProxyCaptureOwner } from "./proxy-capture-owner.js";
import { runDebugProxyRunCommand } from "./proxy-cli.runtime.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "./signal-exit-barrier.js";

const transport = vi.hoisted(() => ({
  gatewayContext: false,
  request: vi.fn(),
  stop: vi.fn(async () => {}),
}));
// A CLI process has no in-process Gateway custody; keep the real physical lock and writer guards.
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    captureGatewayStateOwner: (...args: Parameters<typeof actual.captureGatewayStateOwner>) =>
      transport.gatewayContext ? actual.captureGatewayStateOwner(...args) : undefined,
  };
});
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: transport.request,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  },
}));
vi.mock("../proxy-capture/proxy-server.js", () => ({
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
        await transport.stop();
        await lease?.release();
      },
    };
  },
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const runtimeSource = fileURLToPath(
  new URL("../../extensions/workboard/index.ts", import.meta.url),
);
const disposers: Array<() => void | Promise<void>> = [];
let owner: GatewayLockHandle | null = null;
let handlers: GatewayRequestHandlers;
let config: { gateway: { mode: "local"; port: number } };
let failReply = false;
let revokeBeforeMutation = false;
let current = true;

async function invoke(
  method: string,
  params: Record<string, unknown>,
  scopes = ["operator.admin"],
) {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`Missing handler: ${method}`);
  }
  const client = createSessionMutationTestClient();
  client.connect.scopes = scopes;
  let value: unknown;
  let error: unknown;
  transport.gatewayContext = true;
  try {
    await handler({
      req: { type: "req", id: "fixture", method, params },
      params,
      client,
      isWebchatConnect: () => false,
      context: createSessionMutationTestContext(config),
      hasCurrentClientAuthority: () => current,
      sessionMutationCommitGuard: () => {
        if (!current) {
          throw new Error("fixture authority revoked");
        }
      },
      respond: (ok, result, failure) => {
        if (ok) {
          value = result;
        } else {
          error = failure;
        }
      },
    });
  } finally {
    transport.gatewayContext = false;
  }
  if (error) {
    throw new Error(JSON.stringify(error));
  }
  return value;
}

async function program() {
  const result = new Command().exitOverride();
  const registrars: Array<Parameters<OpenClawPluginApi["registerCli"]>[0]> = [];
  const api = createTestPluginApi({
    registrationMode: "cli-metadata",
    runtimeSource,
    registerCli: (registrar) => {
      registrars.push(registrar);
    },
  });
  workboard.register(api);
  for (const registrar of registrars) {
    await registrar({ program: result, parentPath: [], config, logger: api.logger });
  }
  return result;
}

beforeEach(async () => {
  const root = roots.make("openclaw-cli-capture-workboard-");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const configPath = path.join(root, "openclaw.json");
  config = { gateway: { mode: "local", port: 18789 } };
  await fs.writeFile(configPath, JSON.stringify(config));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  resetConfigRuntimeState();
  handlers = { ...debugProxyHandlers };
  current = true;
  failReply = false;
  revokeBeforeMutation = false;
  transport.gatewayContext = false;
  transport.request
    .mockReset()
    .mockImplementation(
      async (options: {
        method: string;
        params: Record<string, unknown>;
        scopes: string[];
        prepareDispatchCurrent(): Promise<void>;
        assertDispatchCurrent(): void;
      }) => {
        await options.prepareDispatchCurrent();
        options.assertDispatchCurrent();
        if (revokeBeforeMutation) {
          current = false;
        }
        const result = await invoke(options.method, options.params, options.scopes);
        if (failReply) {
          throw new Error("synthetic connection lost after acceptance");
        }
        return result;
      },
    );
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
  await closeOpenClawStateDatabaseAsync();
  await owner?.release();
  owner = null;
  resetConfigRuntimeState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

async function startOwner() {
  transport.gatewayContext = true;
  owner = await acquireGatewayLock({
    env: process.env,
    port: 18789,
    allowInTests: true,
    timeoutMs: 0,
  });
  expect(owner).not.toBeNull();
  transport.gatewayContext = false;
  registerWorkboardGatewayMethods({
    api: createTestPluginApi({
      runtimeSource,
      registerGatewayMethod: (method, handler) => {
        handlers[method] = handler;
      },
      registerRuntimeLifecycle: (lifecycle) => {
        if (lifecycle.dispose) {
          disposers.push(lifecycle.dispose);
        }
      },
    }),
  });
}

describe("standalone CLI owner routing", () => {
  it("routes Workboard writes to the resident owner and invalidates its warmed list", async () => {
    await startOwner();
    await invoke("workboard.cards.list", {});
    const cli = await program();
    await cli.parseAsync(["workboard", "create", "Routed card"], { from: "user" });
    const listed = (await invoke("workboard.cards.list", {})) as {
      cards: Array<{ id: string; status: string; title: string }>;
    };
    expect(listed.cards).toEqual([
      expect.objectContaining({ title: "Routed card", status: "todo" }),
    ]);
    const id = listed.cards[0]!.id;
    await cli.parseAsync(["workboard", "move", id, "--status", "review"], { from: "user" });
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ id, status: "review" }],
    });
    expect(transport.request.mock.calls.map(([request]) => request.method)).toEqual([
      "workboard.cards.create",
      "workboard.cards.list",
      "workboard.cards.move",
    ]);
    expect(transport.request.mock.calls[0]![0].requiredCapabilities).toContain(
      "workboard-cli-owner-v1",
    );
  });

  it("never replays an uncertain Workboard create and rejects revoked authority", async () => {
    await startOwner();
    const cli = await program();
    failReply = true;
    await expect(
      cli.parseAsync(["workboard", "create", "Accepted once"], { from: "user" }),
    ).rejects.toThrow("No local fallback");
    failReply = false;
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ title: "Accepted once" }],
    });
    revokeBeforeMutation = true;
    await expect(
      cli.parseAsync(["workboard", "create", "Must not exist"], { from: "user" }),
    ).rejects.toThrow("No local fallback");
    current = true;
    expect(await invoke("workboard.cards.list", {})).toMatchObject({
      cards: [{ title: "Accepted once" }],
    });
  });

  it("routes standalone proxy session, event and cleanup writes through its owner", async () => {
    await startOwner();
    await runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
    transport.gatewayContext = true;
    const lease = await acquireDebugProxyCaptureStoreAsync();
    try {
      const sessions = await lease.store.listSessions();
      expect(sessions).toEqual([
        expect.objectContaining({ mode: "proxy-run", endedAt: expect.any(Number), eventCount: 1 }),
      ]);
    } finally {
      await lease.release();
      transport.gatewayContext = false;
    }
    expect(transport.request.mock.calls.map(([request]) => request.params.command.type)).toEqual([
      "capture.upsertSession",
      "capture.recordEvent",
      "capture.endSession",
    ]);
  });

  it.each(["online", "offline"])("retains %s proxy cleanup through a signal", async (mode) => {
    if (mode === "online") {
      await startOwner();
    }
    const stopping = createDeferred<void>();
    const resume = createDeferred<void>();
    transport.stop.mockImplementation(async () => {
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
          const token = server.captureEnv.OPENCLAW_DEBUG_PROXY_CAPTURE_TOKEN;
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
          const childEnv = {
            PATH: process.env.PATH,
            HOME: childRoot,
            USERPROFILE: childRoot,
            SystemRoot: process.env.SystemRoot,
            ...applyDebugProxyEnv(
              { OPENCLAW_STATE_DIR: childRoot },
              {
                proxyUrl: server.proxyUrl,
                sessionId: settings.sessionId,
                certDir: settings.certDir,
              },
            ),
            ...server.captureEnv,
          };
          await expect(
            promisify(execFile)(process.execPath, entrypoint, {
              env: {
                ...childEnv,
                OPENCLAW_DEBUG_PROXY_CAPTURE_TOKEN:
                  mode === "online" ? "invalid-fixture-token" : undefined,
              },
            }),
          ).rejects.toThrow(/refused capture|credentials are missing/);
          await expect(
            fs.stat(path.join(childRoot, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await promisify(execFile)(process.execPath, entrypoint, { env: childEnv });
          expect(await store.listSessions()).toEqual([
            expect.objectContaining({
              id: settings.sessionId,
              eventCount: 1,
              endedAt: expect.any(Number),
            }),
          ]);
          await expect(
            fs.stat(path.join(childRoot, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          if (mode === "online") {
            expect(
              transport.request.mock.calls.map(([request]) => request.params.command?.type),
            ).toContain("capture.recordEventWithPayload");
          }
        } finally {
          await server.stop();
        }
      });
    },
  );

  it("admits CLI metadata without opening SQLite and retains the offline command paths", async () => {
    const cli = await program();
    const database = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "plugins",
      "workboard",
      "workboard.sqlite",
    );
    await expect(fs.stat(database)).rejects.toMatchObject({ code: "ENOENT" });
    await cli.parseAsync(["workboard", "create", "Offline card"], { from: "user" });
    await cli.parseAsync(["workboard", "list", "--json"], { from: "user" });
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("Offline card"));
    await runDebugProxyRunCommand({ commandArgs: ["synthetic-child"] });
    expect(transport.request).not.toHaveBeenCalled();
    expect(await readActiveGatewayLockIdentity({ env: process.env })).toBeUndefined();
  });
});
