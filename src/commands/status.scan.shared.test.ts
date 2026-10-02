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
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot as resolveGatewayProbeSnapshotOwner,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const tempDirs: string[] = [];
const resolveGatewayProbeSnapshot = (
  params: Omit<Parameters<typeof resolveGatewayProbeSnapshotOwner>[0], "configPath" | "env">,
) =>
  resolveGatewayProbeSnapshotOwner({
    ...params,
    configPath: "/tmp/openclaw.json",
    env: process.env,
  });

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs(tempDirs);
});

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
  resolveGatewayProbeTarget: vi.fn(),
  probeGateway: vi.fn<typeof import("../gateway/probe.js").probeGateway>(),
  waitForGatewayDiagnosticReadiness: vi.fn(),
  callGateway: vi.fn<typeof import("../gateway/call.js").callGateway>(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  pickGatewaySelfPresence: vi.fn(),
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

vi.mock("../gateway/probe-target.js", () => ({
  resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: mocks.waitForGatewayDiagnosticReadiness,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("./gateway-presence.js", () => ({
  pickGatewaySelfPresence: mocks.pickGatewaySelfPresence,
}));

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.waitForGatewayDiagnosticReadiness.mockReset();
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: { token: "tok", password: "pw" },
      warning: "warn",
    });
    mocks.pickGatewaySelfPresence.mockReturnValue({ host: "box" });
    mocks.callGateway.mockRejectedValue(new Error("status rpc unavailable"));
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: true,
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: createStatusGatewayProbeBudget(),
    });

    expect(mocks.resolveGatewayProbeAuthResolution).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result.remoteUrlMissing).toBe(true);
    expect(result.gatewayMode).toBe("remote");
    expect(result.gatewayProbe).toBeNull();
    expect(result.gatewayReachable).toBe(false);
  });

  it("waits through a 22-second cold start before probing the selected Gateway", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      mocks.resolveGatewayProbeTarget.mockReturnValue({
        gatewayMode: "local",
        remoteUrlMissing: false,
      });
      const startedAt = Date.now();
      mocks.waitForGatewayDiagnosticReadiness.mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 22_000);
        });
        vi.spyOn(performance, "now").mockReturnValue(22_000);
        return { healthy: true, elapsedMs: 22_000, waitOutcome: "healthy" };
      });
      mocks.probeGateway.mockImplementation(async () => ({
        ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
        ok: Date.now() - startedAt >= 22_000,
      }));
      const pending = resolveGatewayProbeSnapshot({
        cfg: {},
        opts: createStatusGatewayProbeBudget(),
      });
      await vi.advanceTimersByTimeAsync(22_000);
      const result = await pending;

      expect(result.gatewayReachable).toBe(true);
      expect(readProbeCall()).toMatchObject({
        timeoutMs: 38_000,
        auth: { token: "tok", password: "pw" },
      });
      expect(mocks.waitForGatewayDiagnosticReadiness).toHaveBeenCalledWith({
        config: {},
        timeoutMs: 60_000,
        deadlineMs: 60_000,
        onProgress: undefined,
        token: "tok",
        password: "pw",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { waitOutcome: "still-starting", startupPhase: "plugins", error: null },
    { waitOutcome: "timeout", startupPhase: undefined, error: "connection refused" },
  ])(
    "preserves $waitOutcome without another probe budget",
    async ({ waitOutcome, startupPhase, error }) => {
      mocks.resolveGatewayProbeTarget.mockReturnValue({
        gatewayMode: "local",
        remoteUrlMissing: false,
      });
      mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({ auth: {}, warning: undefined });
      mocks.waitForGatewayDiagnosticReadiness.mockResolvedValue({
        healthy: false,
        elapsedMs: 60_000,
        waitOutcome,
        startupPhase,
        probeError: error,
      });
      const result = await resolveGatewayProbeSnapshot({
        cfg: {},
        opts: createStatusGatewayProbeBudget(),
      });

      expect(result.gatewayProbe).toMatchObject({ ok: false, error });
      expect(result.gatewayProbe?.startupPhase).toBe(startupPhase);
      expect(mocks.probeGateway).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("can probe the local fallback when remote url is missing", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: true,
    });
    mocks.probeGateway.mockResolvedValue({
      ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
      ok: true,
      connectLatencyMs: 12,
      error: null,
      health: {},
      status: {},
      presence: [{ host: "box", text: "box", ts: 0 }],
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {
        ...createStatusGatewayProbeBudget(),
        detailLevel: "full",
        probeWhenRemoteUrlMissing: true,
        resolveAuthWhenRemoteUrlMissing: true,
        mergeAuthWarningIntoProbeError: false,
      },
    });

    expect(mocks.resolveGatewayProbeAuthResolution).toHaveBeenCalled();
    const probeCall = readProbeCall();
    expect(probeCall.url).toBe("ws://127.0.0.1:18789");
    expect(probeCall.auth).toEqual({ token: "tok", password: "pw" });
    expect(probeCall.detailLevel).toBe("full");
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewaySelf).toEqual({ host: "box" });
    expect(result.gatewayCallOverrides).toEqual({
      url: "ws://127.0.0.1:18789",
      token: "tok",
      password: "pw",
    });
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("treats scope-limited read probes as reachable", async () => {
    mocks.probeGateway.mockResolvedValue({
      ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
      connectLatencyMs: 51,
      gatewayReached: true,
      error: "missing scope: operator.read",
      close: null,
      auth: {
        role: "operator",
        scopes: [],
        capability: "connected_no_operator_scope",
      },
      server: {
        version: null,
        connId: null,
      },
    });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: createStatusGatewayProbeBudget(),
    });

    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewayProbe?.error).toBe("missing scope: operator.read; warn");
  });

  it("uses a bounded local status RPC fallback when the detail probe times out", async () => {
    mocks.probeGateway.mockResolvedValue(
      createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
    );
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: createStatusGatewayProbeBudget(8000),
    });

    const gatewayCall = readGatewayCall();
    expect(gatewayCall.config).toEqual({});
    expect(gatewayCall.method).toBe("status");
    expect(gatewayCall.token).toBe("tok");
    expect(gatewayCall.password).toBe("pw");
    expect(gatewayCall.timeoutMs).toBe(2000);
    expect(gatewayCall.mode).toBe("backend");
    expect(gatewayCall.clientName).toBe("gateway-client");
    expect(gatewayCall).not.toHaveProperty("deviceIdentity");
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewayProbe?.ok).toBe(true);
    expect(result.gatewayProbe?.error).toBe("timeout");
    expect(result.gatewayProbe?.status).toEqual({ sessions: 1 });
    expect(result.gatewayProbe?.auth?.capability).toBe("read_only");
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("does not use the local status RPC fallback for dotted localhost", async () => {
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url: "ws://localhost.:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://localhost.:18789",
    });
    mocks.probeGateway.mockResolvedValue(
      createUnreachableGatewayProbe("ws://localhost.:18789", "timeout"),
    );

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: createStatusGatewayProbeBudget(),
    });

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

    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url,
      urlSource: "local loopback",
      message: `Gateway target: ${url}`,
    });
    mocks.probeGateway.mockImplementation(async () => {
      vi.spyOn(performance, "now").mockReturnValue(150);
      return createUnreachableGatewayProbe(url, "timeout");
    });
    mocks.callGateway.mockImplementation(async (...args: unknown[]) => {
      const { callGateway } =
        await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
      return await callGateway(...(args as Parameters<typeof callGateway>));
    });
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
    const driveStartup = async () => {
      const { completion } = await racePromiseWithAbortSignal(startup.promise, signal);
      const startupState = { settled: false };
      void completion.then(
        () => {
          startupState.settled = true;
        },
        () => {
          startupState.settled = true;
        },
      );
      while (!startupState.settled) {
        signal.throwIfAborted();
        await vi.advanceTimersToNextTimerAsync();
      }
      await completion;
    };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let pending: ReturnType<typeof resolveGatewayProbeSnapshot> | undefined;
    try {
      pending = resolveGatewayProbeSnapshot({
        cfg: { gateway: { auth: { mode: "token", token: "tok" } } },
        opts: createStatusGatewayProbeBudget(parsed?.timeoutMs),
      });

      // Drive deadline time only after real socket requests cross their boundary.
      await driveStartup();
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

  it("lets callGateway reuse paired-device auth for local status RPC fallback", async () => {
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
    });
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: createStatusGatewayProbeBudget(),
    });

    const gatewayCall = readGatewayCall();
    expect(gatewayCall.token).toBeUndefined();
    expect(gatewayCall.password).toBeUndefined();
    expect(gatewayCall).not.toHaveProperty("deviceIdentity");
    expect(result.gatewayReachable).toBe(true);
  });

  it("does not use the status RPC fallback for remote probe failures", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue(
      createUnreachableGatewayProbe("wss://gateway.example/ws", "timeout"),
    );

    const result = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode: "remote", remote: { url: "wss://gateway.example/ws" } } },
      opts: createStatusGatewayProbeBudget(),
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayReachable).toBe(false);
  });
});

describe("buildTailscaleHttpsUrl", () => {
  it("uses the device hostname and configured Control UI base path", () => {
    expect(
      buildTailscaleHttpsUrl({
        tailscaleMode: "serve",
        tailscaleDns: "node.tailnet.ts.net",
        controlUiBasePath: "/control",
      }),
    ).toBe("https://node.tailnet.ts.net/control");
  });
});

function memoryManager<
  T extends import("../memory-host-sdk/engine-storage.js").MemoryProviderStatus,
>(status: T) {
  return {
    probeVectorStoreAvailability: vi.fn(async () => true),
    probeVectorAvailability: vi.fn(async () => true),
    status: vi.fn(() => status),
    close: vi.fn(async () => {}),
  };
}

describe("resolveSharedMemoryStatusSnapshot", () => {
  it("reports native provider health instead of returning a silent null", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockResolvedValue({ status: "ready", message: "connected" });
    const getMemoryProvider = vi.fn().mockResolvedValue({
      providerId: "records",
      provider: { health, close },
    });
    const getMemorySearchManager = vi.fn();

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: { plugins: { slots: { memory: "records" } } },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "records" },
      resolveMemoryConfig: vi.fn(() => null),
      getMemorySearchManager,
      isMemoryProviderNative: () => true,
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

  it("does not resolve the slot owner for Memory Core without a built-in store", async () => {
    const isMemoryProviderNative = vi.fn(() => false);
    const getMemorySearchManager = vi.fn();

    await expect(
      resolveSharedMemoryStatusSnapshot({
        cfg: {},
        agentStatus: { defaultId: "main" },
        memoryPlugin: { enabled: true, slot: "memory-core" },
        resolveMemoryConfig: vi.fn(() => null),
        getMemorySearchManager,
        isMemoryProviderNative,
        requireDefaultDatabasePath: () => null,
      }),
    ).resolves.toBeNull();
    expect(isMemoryProviderNative).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("skips agent-scoped memory when an explicit fleet has no selected owner", async () => {
    const resolveMemoryConfig = vi.fn();
    const getMemorySearchManager = vi.fn();

    await expect(
      resolveSharedMemoryStatusSnapshot({
        cfg: {
          agents: {
            ownership: "explicit",
            entries: { alpha: {}, beta: {} },
          },
        },
        agentStatus: { defaultId: null },
        memoryPlugin: { enabled: true, slot: "memory-core" },
        resolveMemoryConfig,
        getMemorySearchManager,
      }),
    ).resolves.toBeNull();

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("inspects explicitly configured per-agent memory", async () => {
    const cfg = {
      agents: { entries: { main: { memory: { search: { provider: "local" as const } } } } },
    };
    const manager = memoryManager({
      backend: "builtin" as const,
      provider: "local",
      files: 0,
      chunks: 0,
      dirty: true,
    });
    const resolveMemoryConfig = vi.fn(() => ({
      store: { databasePath: `/tmp/openclaw-missing-memory-${process.pid}.sqlite` },
    }));
    const getMemorySearchManager = vi.fn(async () => ({ manager }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg,
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath: () =>
        `/tmp/openclaw-missing-default-memory-${process.pid}.sqlite`,
    });

    expect(resolveMemoryConfig).toHaveBeenCalledOnce();
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "status", inspectSources: true }),
    );
    expect(result).toMatchObject({ provider: "local", dirty: true });
  });

  it("asks custom memory-slot runtimes for status without requiring built-in memorySearch", async () => {
    const manager = memoryManager({
      backend: "builtin" as const,
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
      vector: { enabled: true, available: true },
      fts: { enabled: true, available: true },
    });
    const resolveMemoryConfig = vi.fn(() => null);
    const getMemorySearchManager = vi.fn(async () => ({ manager }));
    const requireDefaultDatabasePath = vi.fn(
      () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    );

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {
        plugins: {
          slots: { memory: "memory-lancedb-pro" },
        },
        memory: { search: { enabled: false } },
      },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath,
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
    expect(result).toEqual({
      agentId: "main",
      backend: "builtin",
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
      vector: { enabled: true, available: true },
      fts: { enabled: true, available: true },
    });
  });

  it("keeps default memory-core on the cold-start store shortcut", async () => {
    const resolveMemoryConfig = vi.fn(() => null);
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath: () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    });

    expect(result).toBeNull();
    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("recognizes shipped memory tables before the manager migrates them", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-status-memory-");
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO files VALUES ('MEMORY.md', 'memory', 'file-hash', 10, 20);
    `);
    db.close();
    const manager = memoryManager({
      backend: "builtin" as const,
      provider: "openai",
      files: 1,
      chunks: 0,
      vector: { enabled: true, available: true },
      fts: { enabled: true, available: true },
    });
    const getMemorySearchManager = vi.fn(async () => ({ manager }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => ({ store: { databasePath } })),
      getMemorySearchManager,
      requireDefaultDatabasePath: () => databasePath,
    });

    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ files: 1 });
  });

  it("does not initialize memory status for an agent database owned by another feature", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-status-memory-");
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
    db.close();
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => ({ store: { databasePath } })),
      getMemorySearchManager,
      requireDefaultDatabasePath: () => databasePath,
    });

    expect(result).toBeNull();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });
});
