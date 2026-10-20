// Status JSON tests cover command output and runtime JSON writes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { statusJsonCommand } from "./status-json.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  scanStatusJsonFast: vi.fn(),
  runSecurityAudit: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  callGateway: vi.fn(),
  resolveGatewayService: vi.fn(),
  resolveNodeService: vi.fn(),
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
  })),
}));

vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: mocks.scanStatusJsonFast,
}));

// mock-isolation: Command policy tests consume a fixed unavailable snapshot without reading stores.
vi.mock("./status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({
    source: "unavailable",
    stores: [],
    reason:
      "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps.",
  }),
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: mocks.resolveGatewayService,
}));
vi.mock("../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
  resolveNodeService: mocks.resolveNodeService,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => null,
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

function createRuntimeCapture() {
  const logs: string[] = [];
  const runtime = {
    ...createTestRuntime(),
    log: vi.fn((value: unknown) => {
      logs.push(String(value));
    }),
  };
  return { runtime, logs };
}

function createScanResult() {
  return {
    cfg: { update: { channel: "stable" } },
    sourceConfig: {},
    summary: { ok: true, configuredChannels: [] },
    osSummary: { platform: "linux" },
    update: { installKind: "npm", git: { tag: null, branch: null } },
    memory: null,
    memoryPlugin: null,
    gatewayMode: "local",
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    remoteUrlMissing: false,
    gatewayReachable: false,
    gatewayProbe: null,
    gatewaySelf: null,
    gatewayProbeAuthWarning: null,
    agentStatus: [],
    secretDiagnostics: [],
  };
}

function createExpectedStatusPayload() {
  return {
    ok: true,
    configuredChannels: [],
    os: { platform: "linux" },
    update: { installKind: "npm", git: { tag: null, branch: null } },
    updateChannel: "stable",
    updateChannelSource: "config",
    memory: null,
    memoryPlugin: null,
    databaseEngines: {
      source: "unavailable",
      experimental: false,
      families: [
        ["state", "Shared state", false],
        ["agent", "Agent data", false],
        ["workboard", "Workboard", false],
        ["logbook", "Logbook", false],
        ["team-reports", "Team Reports", false],
        ["quarantine", "Database quarantine", true],
        ["managed-update", "Managed update handoffs", true],
        ["package-activation", "Package activation journal", true],
      ].map(([id, label, fixedLocal]) => ({
        id,
        label,
        default: "sqlite",
        override: null,
        fixedLocal,
        effective: "sqlite",
      })),
      stores: [],
      reason:
        "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps.",
    },
    gateway: {
      mode: "local",
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
      misconfigured: false,
      reachable: false,
      connectLatencyMs: null,
      self: null,
      error: null,
      authWarning: null,
    },
    gatewayService: {
      label: "LaunchAgent",
      installed: false,
      loadState: { status: "not-loaded" },
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "not loaded",
      runtime: { status: "stopped" },
      loaded: false,
      runtimeShort: "stopped",
    },
    nodeService: {
      label: "LaunchAgent",
      installed: false,
      loadState: { status: "not-loaded" },
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "not loaded",
      runtime: { status: "stopped" },
      loaded: false,
      runtimeShort: "stopped",
    },
    agents: [],
    secretDiagnostics: [],
  };
}

describe("statusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanStatusJsonFast.mockResolvedValue(createScanResult());
    mocks.runSecurityAudit.mockResolvedValue({
      summary: { critical: 1, warn: 0, info: 0 },
      findings: [],
    });
    mocks.resolveGatewayService.mockReturnValue(createMockGatewayService());
    mocks.resolveNodeService.mockReturnValue(createMockGatewayService());
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.callGateway.mockResolvedValue({});
  });

  it("keeps plain status --json off the security audit fast path", async () => {
    const { runtime, logs } = createRuntimeCapture();

    await statusJsonCommand({}, runtime);

    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual(createExpectedStatusPayload());
    expect(payload).not.toHaveProperty("securityAudit");
  });

  it.each([
    { engine: "postgres" },
    { engine: "sqlite", families: { agent: { engine: "postgres" } } },
  ])(
    "reports supported PostgreSQL selections without the experimental flag: %j",
    async (database) => {
      const { runtime, logs } = createRuntimeCapture();
      mocks.scanStatusJsonFast.mockResolvedValueOnce({
        ...createScanResult(),
        cfg: { database },
      });

      await statusJsonCommand({}, runtime);

      const payload = JSON.parse(logs[0] ?? "{}");
      expect(payload.databaseEngines.experimental).toBe(false);
      expect(payload.databaseEngines.families).toContainEqual(
        expect.objectContaining({ id: "agent", effective: "postgres" }),
      );
      expect(payload.databaseEngines.source).toBe("unavailable");
    },
  );

  it("includes security audit and plugin compatibility details when --all is requested", async () => {
    const { runtime, logs } = createRuntimeCapture();
    const compatibilityNotice = {
      pluginId: "legacy-plugin",
      code: "hook-only",
      severity: "warn",
      message: "plugin registers only legacy hooks",
    };
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      pluginCompatibility: [compatibilityNotice],
    });

    await statusJsonCommand({ all: true }, runtime);

    expect(mocks.runSecurityAudit).toHaveBeenCalledExactlyOnceWith({
      config: { update: { channel: "stable" } },
      sourceConfig: {},
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      ...createExpectedStatusPayload(),
      securityAudit: {
        summary: { critical: 1, warn: 0, info: 0 },
        findings: [],
      },
      pluginCompatibility: {
        count: 1,
        warnings: [compatibilityNotice],
      },
    });
  });

  it("reports deep gateway probe failures and runs the documented security audit", async () => {
    const { runtime, logs } = createRuntimeCapture();
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayReachable: true,
    });
    mocks.callGateway.mockImplementation(async (params: { method?: string }) => {
      if (params.method === "health") {
        throw new Error("gateway health probe timed out");
      }
      return null;
    });

    await statusJsonCommand({ deep: true }, runtime);

    expect(mocks.runSecurityAudit).toHaveBeenCalledOnce();
    const payload = JSON.parse(logs[0] ?? "{}") as {
      health?: { error?: string };
      securityAudit?: { summary?: { critical?: number } };
    };
    expect(payload.health).toEqual({ error: "Error: gateway health probe timed out" });
    expect(payload.securityAudit?.summary?.critical).toBe(1);
  });
});
