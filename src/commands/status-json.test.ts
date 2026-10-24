// Status JSON tests cover command output and runtime JSON writes.
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    // The complete schema is owned by status-json-runtime; this boundary covers
    // the absent-probe defaults and real service-summary composition.
    expect(payload).toMatchObject({
      configuredChannels: [],
      memoryPlugin: null,
      agents: [],
      update: { installKind: "npm", git: { tag: null, branch: null } },
    });
    expect(payload.gateway).toEqual({
      mode: "local",
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
      misconfigured: false,
      reachable: false,
      connectLatencyMs: null,
      self: null,
      error: null,
      authWarning: null,
    });
    for (const field of ["gatewayService", "nodeService"]) {
      expect(payload[field]).toEqual({
        label: "LaunchAgent",
        installed: false,
        loadState: { status: "not-loaded" },
        managedByOpenClaw: false,
        externallyManaged: false,
        loadedText: "not loaded",
        runtime: { status: "stopped" },
        loaded: false,
        runtimeShort: "stopped",
      });
    }
    expect(payload).not.toHaveProperty("securityAudit");
    expect(payload).not.toHaveProperty("pluginCompatibility");
  });

  it("builds remote gateway JSON payloads consistently", async () => {
    const { runtime, logs } = createRuntimeCapture();
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayMode: "remote",
      gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
      gatewayReachable: true,
      gatewayProbe: { connectLatencyMs: 123, error: null },
      gatewaySelf: { host: "gateway", version: "1.2.3" },
      gatewayProbeAuthWarning: "warn",
    });

    await statusJsonCommand({}, runtime);

    const payload = JSON.parse(logs[0] ?? "{}");
    expect(payload.gateway).toEqual({
      mode: "remote",
      url: "wss://gateway.example.com",
      urlSource: "config",
      misconfigured: false,
      reachable: true,
      connectLatencyMs: 123,
      self: { host: "gateway", version: "1.2.3" },
      error: null,
      authWarning: "warn",
    });
  });

  it("redacts credential-bearing Gateway URLs from JSON status", async () => {
    const { runtime, logs } = createRuntimeCapture();
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayMode: "remote",
      gatewayConnection: {
        url: "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed",
        urlSource: "cli --url",
      },
      gatewayProbe: { error: "unreachable" },
    });

    await statusJsonCommand({}, runtime);

    const payload = JSON.parse(logs[0] ?? "{}");
    expect(payload.gateway.url).toContain("gateway.example/ws");
    expect(JSON.stringify(payload.gateway)).not.toMatch(/password|secret|api-key|signed/);
  });

  it("reports startup phase without an unreachable error in JSON", async () => {
    const { runtime, logs } = createRuntimeCapture();
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayProbe: { startupPhase: "plugins", error: null },
    });

    await statusJsonCommand({}, runtime);

    const payload = JSON.parse(logs[0] ?? "{}");
    expect(payload.gateway).toMatchObject({
      readiness: "still-starting",
      startupPhase: "plugins",
      error: null,
    });
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
      loadPluginSecurityCollectors: false,
    });
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect({
      securityAudit: payload.securityAudit,
      pluginCompatibility: payload.pluginCompatibility,
    }).toEqual({
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

it("includes local recovery copy bytes in status --json without retiring them", async () => {
  await withOpenClawTestState({ label: "status-recovery-json", applyEnv: true }, async (state) => {
    fs.mkdirSync(state.statePath("state"), { recursive: true });
    const file = state.statePath("state", "openclaw.sqlite.pre-startup-migration-old.bak");
    fs.writeFileSync(file, "original");
    mocks.scanStatusJsonFast.mockResolvedValueOnce({ ...createScanResult(), env: state.env });
    const { runtime, logs } = createRuntimeCapture();
    await statusJsonCommand({}, runtime);
    const payload = JSON.parse(logs[0] ?? "{}");
    expect(payload.recoveryCopies).toMatchObject({
      scope: "local",
      incomplete: false,
      total: { count: 1, logicalBytes: 8, unmanifestedOrOrphan: { count: 1, logicalBytes: 8 } },
      byKind: { migrationOriginals: { count: 1, logicalBytes: 8 } },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
});
