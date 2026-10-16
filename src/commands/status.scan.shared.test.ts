import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as clientReadiness from "../../packages/gateway-client/src/readiness.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { parseStatusRouteArgs } from "../cli/program/route-args.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import type { GatewayProbeAuth } from "../gateway/probe.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot as resolveGatewayProbeSnapshotOwner,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const tempDirs: string[] = [];
const localUrl = "ws://127.0.0.1:18789";
const auth = { token: "tok", password: "pw" };
const unreachableProbe = (url = localUrl) => createUnreachableGatewayProbe(url, "timeout");
const resolveGatewayProbeSnapshot = (
  params: Partial<Parameters<typeof resolveGatewayProbeSnapshotOwner>[0]> = {},
) =>
  resolveGatewayProbeSnapshotOwner({
    cfg: {},
    opts: createStatusGatewayProbeBudget(),
    configPath: "/tmp/openclaw.json",
    env: process.env,
    ...params,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanupTempDirs(tempDirs);
});

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
  probeGateway: vi.fn<typeof import("../gateway/probe.js").probeGateway>(),
  waitForGatewayDiagnosticReadiness: vi.fn(),
  callGateway: vi.fn<typeof import("../gateway/call.js").callGateway>(),
  resolveGatewayProbeAuthResolution: vi.fn(),
}));

function readGatewayCall() {
  expect(mocks.callGateway).toHaveBeenCalledOnce();
  return mocks.callGateway.mock.calls[0]![0];
}

function readProbeCall() {
  expect(mocks.probeGateway).toHaveBeenCalledOnce();
  return mocks.probeGateway.mock.calls[0]![0];
}

vi.mock("../gateway/connection-details.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/connection-details.js")>()),
  buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetailsWithResolvers,
}));

vi.mock("../gateway/probe.js", () => ({ probeGateway: mocks.probeGateway }));

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: mocks.waitForGatewayDiagnosticReadiness,
}));

vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

function setConnection(url: string) {
  mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
    url,
    urlSource: "local loopback",
  });
}

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.waitForGatewayDiagnosticReadiness.mockReset();
    setConnection(localUrl);
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({ auth, warning: "warn" });
    mocks.callGateway.mockRejectedValue(new Error("status rpc unavailable"));
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    const result = await resolveGatewayProbeSnapshot({ cfg: { gateway: { mode: "remote" } } });

    expect(mocks.resolveGatewayProbeAuthResolution).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      remoteUrlMissing: true,
      gatewayMode: "remote",
      gatewayProbe: null,
      gatewayReachable: false,
    });
  });

  it("waits through a 22-second cold start before probing the selected Gateway", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const startedAt = Date.now();
    mocks.waitForGatewayDiagnosticReadiness.mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 22_000);
      });
      vi.spyOn(performance, "now").mockReturnValue(22_000);
      return { healthy: true, elapsedMs: 22_000, waitOutcome: "healthy" };
    });
    mocks.probeGateway.mockImplementation(async () => ({
      ...unreachableProbe(),
      ok: Date.now() - startedAt >= 22_000,
    }));
    const pending = resolveGatewayProbeSnapshot();
    await vi.advanceTimersByTimeAsync(22_000);
    const result = await pending;

    expect(result).toMatchObject({ gatewayReachable: true, localGatewayHealthy: true });
    expect(readProbeCall()).toMatchObject({ timeoutMs: 38_000, auth });
    expect(mocks.waitForGatewayDiagnosticReadiness).toHaveBeenCalledWith({
      config: {},
      timeoutMs: 60_000,
      deadlineMs: 60_000,
      onProgress: undefined,
      token: "tok",
      password: "pw",
    });
  });

  it.each([
    { waitOutcome: "still-starting", startupPhase: "plugins", error: null },
    { waitOutcome: "timeout", startupPhase: undefined, error: "connection refused" },
  ])(
    "preserves $waitOutcome without another probe budget",
    async ({ waitOutcome, startupPhase, error }) => {
      mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({ auth: {}, warning: undefined });
      mocks.waitForGatewayDiagnosticReadiness.mockResolvedValue({
        healthy: false,
        elapsedMs: 60_000,
        waitOutcome,
        startupPhase,
        probeError: error,
      });
      const result = await resolveGatewayProbeSnapshot();

      expect(result.gatewayProbe).toMatchObject({ ok: false, error });
      expect(result.gatewayProbe?.startupPhase).toBe(startupPhase);
      expect(result.localGatewayHealthy).toBe(false);
      expect(mocks.probeGateway).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["plugin-errors", ["fixture plugin failed"], true],
    ["probe-failed", undefined, false],
  ] as const)(
    "does not claim current local health from %s",
    async (_observation, activatedPluginErrors, ok) => {
      mocks.waitForGatewayDiagnosticReadiness.mockResolvedValue({
        healthy: true,
        waitOutcome: "healthy",
        ...(activatedPluginErrors ? { activatedPluginErrors } : {}),
      });
      mocks.probeGateway.mockResolvedValue({ ...unreachableProbe(), ok });
      const result = await resolveGatewayProbeSnapshot();
      expect(result.localGatewayHealthy).toBe(false);
    },
  );

  it("treats scope-limited read probes as reachable", async () => {
    mocks.probeGateway.mockResolvedValue({
      ...unreachableProbe(),
      gatewayReached: true,
      error: "missing scope: operator.read",
      auth: {
        role: "operator",
        scopes: [],
        capability: "connected_no_operator_scope",
      },
    });

    const result = await resolveGatewayProbeSnapshot();

    expect(result).toMatchObject({
      gatewayReachable: true,
      gatewayProbe: { error: "missing scope: operator.read; warn" },
    });
  });

  it.each(["configured", "paired-device"])(
    "uses bounded local status RPC fallback with %s auth",
    async (source) => {
      const paired = source === "paired-device";
      const credentials: GatewayProbeAuth = paired ? {} : auth;
      mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
        auth: credentials,
        warning: paired ? undefined : "warn",
      });
      mocks.probeGateway.mockResolvedValue({
        ...unreachableProbe(),
        ...(paired
          ? {
              auth: {
                role: "operator",
                scopes: ["operator.read"],
                capability: "read_only" as const,
              },
            }
          : {}),
      });
      mocks.callGateway.mockResolvedValue({ sessions: 1 });

      const result = await resolveGatewayProbeSnapshot({
        opts: createStatusGatewayProbeBudget(8000),
      });

      const gatewayCall = readGatewayCall();
      expect(gatewayCall).toMatchObject({
        config: {},
        method: "status",
        token: credentials.token,
        password: credentials.password,
        timeoutMs: 2000,
        mode: "backend",
        clientName: "gateway-client",
      });
      expect(gatewayCall.config).toEqual({});
      expect(gatewayCall).not.toHaveProperty("deviceIdentity");
      expect(result).toMatchObject({
        gatewayReachable: true,
        gatewayProbeAuthWarning: paired ? undefined : "warn",
        gatewayProbe: { ok: true, error: "timeout", auth: { capability: "read_only" } },
      });
      expect(result.gatewayProbe?.status).toEqual({ sessions: 1 });
    },
  );

  it("does not use the local status RPC fallback for dotted localhost", async () => {
    setConnection("ws://localhost.:18789");
    mocks.probeGateway.mockResolvedValue(unreachableProbe("ws://localhost.:18789"));

    const result = await resolveGatewayProbeSnapshot();

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayProbe?.ok).toBe(false);
  });

  it("gives a real local fallback status RPC only the remaining explicit CLI timeout", async ({
    signal,
  }) => {
    const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(gateway, "listening");
    const address = gateway.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;
    const observedMethods: string[] = [];
    const statusRequested = createDeferred();
    gateway.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.type !== "req" || !frame.id || !frame.method) {
          return;
        }
        const requestId = frame.id;
        if (frame.method === "connect") {
          sendMinimalGatewayResponse(
            socket,
            requestId,
            buildMinimalGatewayHelloOkPayload({
              methods: ["system-presence", "status"],
              auth: { role: "operator", scopes: ["operator.read"] },
            }),
          );
          return;
        }
        observedMethods.push(frame.method);
        if (frame.method === "status") {
          statusRequested.resolve();
          const responseTimer = setTimeout(() => {
            if (socket.readyState === socket.OPEN) {
              sendMinimalGatewayResponse(socket, requestId, { sessions: 1 });
            }
          }, 400);
          responseTimer.unref();
        }
      });
    });

    setConnection(url);
    mocks.probeGateway.mockImplementation(async () => {
      vi.spyOn(performance, "now").mockReturnValue(150);
      return unreachableProbe(url);
    });
    const { callGateway } =
      await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
    mocks.callGateway.mockImplementation(callGateway);
    const parsed = parseStatusRouteArgs(["node", "openclaw", "status", "--timeout", "250"]);
    expect(parsed?.timeoutMs).toBe(250);

    const startup = createDeferred<{
      completion: ReturnType<typeof clientReadiness.startGatewayClientWhenEventLoopReady>;
    }>();
    const startClient = clientReadiness.startGatewayClientWhenEventLoopReady;
    const startupSpy = vi
      .spyOn(clientReadiness, "startGatewayClientWhenEventLoopReady")
      .mockImplementation((...args) => {
        const completion = startClient(...args);
        startup.resolve({ completion });
        return completion;
      });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let pending: ReturnType<typeof resolveGatewayProbeSnapshot> | undefined;
    try {
      pending = resolveGatewayProbeSnapshot({
        cfg: { gateway: { auth: { mode: "token", token: "tok" } } },
        opts: createStatusGatewayProbeBudget(parsed?.timeoutMs),
      });

      // Drive deadline time only after real socket requests cross their boundary.
      const { completion } = await racePromiseWithAbortSignal(startup.promise, signal);
      const state = { settled: false };
      const settle = () => {
        state.settled = true;
      };
      void completion.then(settle, settle);
      while (!state.settled) {
        signal.throwIfAborted();
        await vi.advanceTimersToNextTimerAsync();
      }
      await completion;
      await racePromiseWithAbortSignal(statusRequested.promise, signal);
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(readProbeCall().timeoutMs).toBe(250);
      expect(readGatewayCall().timeoutMs).toBe(100);
      expect(startupSpy).toHaveBeenCalledOnce();
      expect(observedMethods).toEqual(["status"]);
      expect(result.gatewayProbe?.ok).toBe(false);
      expect(result.gatewayProbe?.error).toContain("timeout");
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      startupSpy.mockRestore();
      await closeMinimalGatewayServer(gateway);
      await Promise.allSettled([pending]);
    }
  });

  it("does not use the status RPC fallback for remote probe failures", async () => {
    mocks.probeGateway.mockResolvedValue(unreachableProbe("wss://gateway.example/ws"));

    const result = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode: "remote", remote: { url: "wss://gateway.example/ws" } } },
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayReachable).toBe(false);
  });
});

it("builds the Tailscale URL from the device hostname and configured Control UI base path", () => {
  expect(
    buildTailscaleHttpsUrl({
      tailscaleMode: "serve",
      tailscaleDns: "node.tailnet.ts.net",
      controlUiBasePath: "/control",
    }),
  ).toBe("https://node.tailnet.ts.net/control");
});

function memoryManager(status: MemoryProviderStatus) {
  return {
    probeVectorStoreAvailability: vi.fn(async () => true),
    probeVectorAvailability: vi.fn(async () => true),
    status: vi.fn(() => status),
    close: vi.fn(async () => {}),
  };
}

describe("resolveSharedMemoryStatusSnapshot", () => {
  type MemoryParams = Parameters<typeof resolveSharedMemoryStatusSnapshot>[0];
  const resolveMemoryConfig = vi.fn<MemoryParams["resolveMemoryConfig"]>();
  const getMemorySearchManager = vi.fn<MemoryParams["getMemorySearchManager"]>();
  const isMemoryProviderNative = vi.fn<NonNullable<MemoryParams["isMemoryProviderNative"]>>();
  const requireDefaultDatabasePath =
    vi.fn<NonNullable<MemoryParams["requireDefaultDatabasePath"]>>();
  const absentDatabase = `/tmp/openclaw-missing-memory-${process.pid}.sqlite`;
  const memorySnapshot = (params: Partial<MemoryParams> = {}) =>
    resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      isMemoryProviderNative,
      requireDefaultDatabasePath,
      ...params,
    });
  beforeEach(() => {
    resolveMemoryConfig.mockReset().mockReturnValue(null);
    getMemorySearchManager.mockReset().mockResolvedValue({ manager: null });
    isMemoryProviderNative.mockReset().mockReturnValue(false);
    requireDefaultDatabasePath.mockReset().mockReturnValue(null);
  });

  it("reports native provider health instead of returning a silent null", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockResolvedValue({ status: "ready", message: "connected" });
    const getMemoryProvider = vi.fn().mockResolvedValue({
      providerId: "records",
      provider: { health, close },
    });
    isMemoryProviderNative.mockReturnValue(true);
    const result = await memorySnapshot({
      memoryPlugin: { enabled: true, slot: "records" },
      getMemoryProvider,
    });

    expect(getMemoryProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        purpose: "status",
        context: expect.objectContaining({ authority: { kind: "host", operation: "status" } }),
      }),
    );
    expect(result).toEqual({
      agentId: "main",
      provider: "records",
      health: { status: "ready", message: "connected" },
    });
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each<{
    state: string;
    params: Partial<MemoryParams>;
    path: string | null;
    unused: typeof resolveMemoryConfig | typeof isMemoryProviderNative;
  }>`
    state             | params                                                                                                                | path              | unused
    ${"unconfigured"} | ${{}}                                                                                                                 | ${null}           | ${isMemoryProviderNative}
    ${"ownerless"}    | ${{ cfg: { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }, agentStatus: { defaultId: null } }} | ${null}           | ${resolveMemoryConfig}
    ${"cold-start"}   | ${{}}                                                                                                                 | ${absentDatabase} | ${resolveMemoryConfig}
  `(
    "keeps $state Memory Core from opening a manager",
    async ({ params, path: databasePath, unused }) => {
      requireDefaultDatabasePath.mockReturnValue(databasePath);
      await expect(memorySnapshot(params)).resolves.toBeNull();
      expect(getMemorySearchManager).not.toHaveBeenCalled();
      expect(unused).not.toHaveBeenCalled();
    },
  );

  it("inspects explicitly configured per-agent memory", async () => {
    const manager = memoryManager({ backend: "builtin", provider: "local", dirty: true });
    resolveMemoryConfig.mockReturnValue({ store: { databasePath: absentDatabase } });
    getMemorySearchManager.mockResolvedValue({ manager });
    requireDefaultDatabasePath.mockReturnValue(`${absentDatabase}-default`);
    const result = await memorySnapshot({
      cfg: { agents: { entries: { main: { memory: { search: { provider: "local" } } } } } },
    });

    expect(resolveMemoryConfig).toHaveBeenCalledOnce();
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "status", inspectSources: true }),
    );
    expect(result).toMatchObject({ provider: "local", dirty: true });
  });

  it("asks custom memory-slot runtimes for status without requiring built-in memorySearch", async () => {
    const status = {
      backend: "builtin" as const,
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
      vector: { enabled: true, available: true },
      fts: { enabled: true, available: true },
    };
    const manager = memoryManager(status);
    getMemorySearchManager.mockResolvedValue({ manager });
    requireDefaultDatabasePath.mockReturnValue(absentDatabase);

    const result = await memorySnapshot({
      cfg: {
        plugins: { slots: { memory: "memory-lancedb-pro" } },
        memory: { search: { enabled: false } },
      },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
    });

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(requireDefaultDatabasePath).not.toHaveBeenCalled();
    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ plugins: { slots: { memory: "memory-lancedb-pro" } } }),
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });
    expect(manager.probeVectorStoreAvailability).toHaveBeenCalled();
    expect(manager.probeVectorAvailability).not.toHaveBeenCalled();
    expect(manager.status).toHaveBeenCalled();
    expect(manager.close).toHaveBeenCalled();
    expect(result).toEqual({ agentId: "main", ...status });
  });

  it("recognizes legacy memory table presence before manager migration", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-status-memory-");
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(databasePath);
    // Presence reads table names and one row, not the rest of the legacy index schema.
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (path TEXT PRIMARY KEY);
      INSERT INTO files VALUES ('MEMORY.md');
    `);
    db.close();
    const manager = memoryManager({ backend: "builtin", provider: "openai", files: 1 });
    getMemorySearchManager.mockResolvedValue({ manager });
    resolveMemoryConfig.mockReturnValue({ store: { databasePath } });
    requireDefaultDatabasePath.mockReturnValue(databasePath);
    const result = await memorySnapshot();

    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ files: 1 });
  });
});
