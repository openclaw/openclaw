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

async function runJson(opts: Parameters<typeof statusJsonCommand>[0] = {}) {
  const logs: string[] = [];
  const runtime = {
    ...createTestRuntime(),
    log: vi.fn((value: unknown) => {
      logs.push(String(value));
    }),
  };
  await statusJsonCommand(opts, runtime);
  expect(logs).toStrictEqual([expect.any(String)]);
  return logs[0] ?? "{}";
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
    const payload = JSON.parse(await runJson()) as Record<string, unknown>;
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
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
    expect(payload).not.toHaveProperty("securityAudit");
    expect(payload).not.toHaveProperty("pluginCompatibility");
  });

  it("redacts credential-bearing Gateway URLs from JSON status", async () => {
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayMode: "remote",
      gatewayConnection: {
        url: "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed",
        urlSource: "cli --url",
      },
      gatewayProbe: { error: "unreachable" },
    });

    const payload = JSON.parse(await runJson());
    expect(payload.gateway.url).toContain("gateway.example/ws");
    expect(JSON.stringify(payload.gateway)).not.toMatch(/password|secret|api-key|signed/);
  });

  it("reports startup phase without an unreachable error in JSON", async () => {
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayProbe: { startupPhase: "plugins", error: null },
    });

    const payload = JSON.parse(await runJson());
    expect(payload.gateway).toMatchObject({
      readiness: "still-starting",
      startupPhase: "plugins",
      error: null,
    });
  });

  it("includes security audit and plugin compatibility details when --all is requested", async () => {
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

    const payload = JSON.parse(await runJson({ all: true })) as Record<string, unknown>;

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

    const payload = JSON.parse(await runJson({ deep: true })) as {
      health?: { error?: string };
      securityAudit?: { summary?: { critical?: number } };
    };
    expect(mocks.runSecurityAudit).toHaveBeenCalledOnce();
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
    const payload = JSON.parse(await runJson());
    expect(payload.recoveryCopies).toMatchObject({
      scope: "local",
      incomplete: false,
      total: { count: 1, logicalBytes: 8, unmanifestedOrOrphan: { count: 1, logicalBytes: 8 } },
      byKind: { migrationOriginals: { count: 1, logicalBytes: 8 } },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
});
