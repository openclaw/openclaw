import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot as resolveGatewayProbeSnapshotOwner,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const tempDirs: string[] = [];
const resolveGatewayProbeSnapshot = (
  cfg: Parameters<typeof resolveGatewayProbeSnapshotOwner>[0]["cfg"] = {},
  opts = createStatusGatewayProbeBudget(),
) =>
  resolveGatewayProbeSnapshotOwner({
    cfg,
    opts,
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
  getMemorySearchManager: vi.fn(),
}));

function readGatewayCall() {
  expect(mocks.callGateway).toHaveBeenCalledOnce();
  return mocks.callGateway.mock.calls[0]![0];
}

function readProbeCall() {
  expect(mocks.probeGateway).toHaveBeenCalledOnce();
  return mocks.probeGateway.mock.calls[0]![0];
}

function gatewayTarget(url = "ws://127.0.0.1:18789") {
  mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
    url,
    urlSource: "local loopback",
    message: `Gateway target: ${url}`,
  });
}

const unreachableProbe = (url = "ws://127.0.0.1:18789") =>
  createUnreachableGatewayProbe(url, "timeout");

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

vi.mock("./status.scan.deps.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.scan.deps.runtime.js")>()),
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.waitForGatewayDiagnosticReadiness.mockReset();
    gatewayTarget();
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: { token: "tok", password: "pw" },
      warning: "warn",
    });
    mocks.callGateway.mockRejectedValue(new Error("status rpc unavailable"));
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: true,
    });
    const result = await resolveGatewayProbeSnapshot();

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
    try {
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

      expect(result.gatewayReachable).toBe(true);
      expect(result.localGatewayHealthy).toBe(true);
      expect(readProbeCall()).toMatchObject({
        timeoutMs: 38_000,
        auth: { token: "tok", password: "pw" },
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

  it.each(["plugin-errors", "probe-failed"])(
    "does not claim current local health from %s",
    async (observation) => {
      mocks.waitForGatewayDiagnosticReadiness.mockResolvedValue({
        healthy: true,
        waitOutcome: "healthy",
        ...(observation === "plugin-errors"
          ? { activatedPluginErrors: ["fixture plugin failed"] }
          : {}),
      });
      mocks.probeGateway.mockResolvedValue({
        ...unreachableProbe(),
        ok: observation !== "probe-failed",
      });
      const result = await resolveGatewayProbeSnapshot();
      expect(result.localGatewayHealthy).toBe(false);
    },
  );

  it.each([true, false])(
    "uses bounded local fallback with explicit credentials=%s",
    async (explicit) => {
      if (!explicit) {
        mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({ auth: {}, warning: undefined });
      }
      mocks.probeGateway.mockResolvedValue({
        ...unreachableProbe(),
        ...(!explicit
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

      const result = await resolveGatewayProbeSnapshot({}, createStatusGatewayProbeBudget(8000));

      const gatewayCall = readGatewayCall();
      expect(gatewayCall).toMatchObject({
        token: explicit ? "tok" : undefined,
        password: explicit ? "pw" : undefined,
        timeoutMs: 2000,
      });
      expect(gatewayCall).not.toHaveProperty("deviceIdentity");
      expect(result).toMatchObject({
        gatewayReachable: true,
        gatewayProbe: { ok: true, error: "timeout", auth: { capability: "read_only" } },
        gatewayProbeAuthWarning: explicit ? "warn" : undefined,
      });
      expect(result.gatewayProbe?.status).toEqual({ sessions: 1 });
    },
  );

  it("does not use the local status RPC fallback for dotted localhost", async () => {
    gatewayTarget("ws://localhost.:18789");
    mocks.probeGateway.mockResolvedValue(unreachableProbe("ws://localhost.:18789"));

    const result = await resolveGatewayProbeSnapshot();

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayProbe?.ok).toBe(false);
  });

  it("gives the fallback status RPC only the remaining explicit CLI timeout", async () => {
    mocks.probeGateway.mockImplementation(async () => {
      vi.spyOn(performance, "now").mockReturnValue(150);
      return unreachableProbe();
    });
    const result = await resolveGatewayProbeSnapshot(
      { gateway: { auth: { mode: "token", token: "tok" } } },
      createStatusGatewayProbeBudget(250),
    );
    expect(readProbeCall().timeoutMs).toBe(250);
    expect(readGatewayCall()).toMatchObject({ method: "status", timeoutMs: 100 });
    expect(result.gatewayProbe).toMatchObject({ ok: false, error: "timeout; warn" });
  });

  it("does not use the status RPC fallback for remote probe failures", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue(unreachableProbe("wss://gateway.example/ws"));

    const result = await resolveGatewayProbeSnapshot({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example/ws" } },
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

function memoryManager(
  status: Omit<import("../memory-host-sdk/engine-storage.js").MemoryProviderStatus, "backend">,
) {
  return {
    probeVectorStoreAvailability: vi.fn(async () => true),
    probeVectorAvailability: vi.fn(async () => true),
    status: vi.fn(() => ({ backend: "builtin" as const, files: 0, chunks: 0, ...status })),
    close: vi.fn(async () => {}),
  };
}

describe("resolveSharedMemoryStatusSnapshot", () => {
  const getMemorySearchManager = mocks.getMemorySearchManager;
  beforeEach(() => getMemorySearchManager.mockReset().mockResolvedValue({ manager: null }));

  function memorySnapshot(
    overrides: Partial<Parameters<typeof resolveSharedMemoryStatusSnapshot>[0]> = {},
  ) {
    return resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => null),
      ...overrides,
    });
  }

  it("reports native provider health instead of returning a silent null", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockResolvedValue({ status: "ready", message: "connected" });
    const getMemoryProvider = vi.fn().mockResolvedValue({
      providerId: "records",
      provider: { health, close },
    });

    const result = await memorySnapshot({
      cfg: { plugins: { slots: { memory: "records" } } },
      memoryPlugin: { enabled: true, slot: "records" },
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

  it.each(["unconfigured", "unowned fleet", "cold store"])("skips memory for %s", async (kind) => {
    const isMemoryProviderNative = vi.fn(() => false);
    const resolveMemoryConfig = vi.fn();
    await expect(
      memorySnapshot({
        cfg:
          kind === "unowned fleet"
            ? { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }
            : {},
        agentStatus: { defaultId: kind === "unowned fleet" ? null : "main" },
        isMemoryProviderNative,
        ...(kind !== "unconfigured" ? { resolveMemoryConfig } : {}),
        requireDefaultDatabasePath: () =>
          kind === "cold store" ? `/tmp/openclaw-missing-memory-${process.pid}.sqlite` : null,
      }),
    ).resolves.toBeNull();
    expect(isMemoryProviderNative).not.toHaveBeenCalled();
    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each(["explicit config", "shipped tables"])("inspects memory with %s", async (source) => {
    const databasePath = path.join(makeTempDir(tempDirs, "status-memory-"), "memory.sqlite");
    if (source === "shipped tables") {
      using db = new DatabaseSync(databasePath);
      db.exec("CREATE TABLE files (path TEXT PRIMARY KEY); INSERT INTO files VALUES ('MEMORY.md')");
    }
    getMemorySearchManager.mockResolvedValue({
      manager: memoryManager({ provider: "local", files: 1, dirty: true }),
    });
    const result = await memorySnapshot({
      cfg:
        source === "explicit config"
          ? { agents: { entries: { main: { memory: { search: { provider: "local" } } } } } }
          : {},
      resolveMemoryConfig: () => ({ store: { databasePath } }),
      requireDefaultDatabasePath: () => databasePath,
    });
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "status", inspectSources: true }),
    );
    expect(result).toMatchObject({ provider: "local", files: 1, dirty: true });
  });

  it("asks custom memory-slot runtimes for status without requiring built-in memorySearch", async () => {
    const manager = memoryManager({
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
    });
    const resolveMemoryConfig = vi.fn(() => null);
    getMemorySearchManager.mockResolvedValue({ manager });
    const requireDefaultDatabasePath = vi.fn(
      () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    );

    const result = await memorySnapshot({
      cfg: {
        plugins: { slots: { memory: "memory-lancedb-pro" } },
        memory: { search: { enabled: false } },
      },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      resolveMemoryConfig,
      requireDefaultDatabasePath,
    });

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(requireDefaultDatabasePath).not.toHaveBeenCalled();
    expect(manager.probeVectorStoreAvailability).toHaveBeenCalled();
    expect(manager.probeVectorAvailability).not.toHaveBeenCalled();
    expect(manager.close).toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "main",
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
    });
  });
});
