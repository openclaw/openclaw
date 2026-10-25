import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  readRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import type { resolveStatusRuntimeSnapshot } from "./status-runtime-shared.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import type { StatusJsonScanResult } from "./status.scan-result.ts";
import { createStatusScanResultFixture } from "./status.test-support.ts";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const backup = {
  latest: {
    id: "backup-1",
    createdAt: 123,
    archivePath: "/backups/git",
    status: "ok",
    kind: "git",
  },
} as const;
const runtimeSnapshot = {
  securityAudit: { summary: { critical: 1 } },
  usage: { providers: [] },
  health: { ok: true },
  lastHeartbeat: { status: "ok" },
  gatewayService: { label: "LaunchAgent" },
  nodeService: { label: "node" },
};
const unavailableDatabases = {
  source: "unavailable",
  stores: [],
  reason: "Physical store inspection unavailable in fixture.",
};

const mocks = vi.hoisted(() => ({
  scanStatusJsonFast: vi.fn(),
  writeRuntimeJson: vi.fn((_runtime: RuntimeEnv, _output: Record<string, unknown>) => {}),
  readBackupRunFreshness: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveStatusRuntimeSnapshot: vi.fn(),
  resolveStatusUsageSummary: vi.fn(),
}));

// mock-isolation: Fixed scan facts keep output composition independent of live Gateway collection.
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: mocks.scanStatusJsonFast }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  writeRuntimeJson: mocks.writeRuntimeJson,
}));
vi.mock("../infra/update-run-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-status.js")>()),
  readUpdateRunStatus: async () => ({}),
}));

// mock-isolation: Keep store discovery out of these runtime composition tests.
vi.mock("./status-database-engines.js", () => ({
  resolveStatusDatabaseEngines: async () => unavailableDatabases,
}));

// mock-isolation: Keep config I/O out of this fixture while exercising the real snapshot owner.
vi.mock("../config/config.js", async () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  setAppliedRuntimeConfigSnapshot: (await import("../config/runtime-snapshot.js"))
    .setAppliedRuntimeConfigSnapshot,
}));

// mock-isolation: Status composition consumes retained backup facts without opening their store.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: mocks.readBackupRunFreshness,
}));

// mock-isolation: Exercise the usage callback without starting Gateway or daemon probes.
vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: mocks.resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary: mocks.resolveStatusUsageSummary,
}));

function createScan() {
  return createStatusScanResultFixture({
    env: { OPENCLAW_STATE_DIR: "/tmp/status-json-runtime-state" },
  });
}

async function runJson(
  scan: StatusJsonScanResult,
  opts: Parameters<typeof runStatusJsonCommand>[0]["opts"],
) {
  mocks.scanStatusJsonFast.mockResolvedValueOnce(scan);
  await runStatusJsonCommand({ opts, runtime: createTestRuntime() });
  return expectDefined(mocks.writeRuntimeJson.mock.lastCall, "status JSON output")[1];
}

describe("runStatusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.readBackupRunFreshness.mockResolvedValue(structuredClone(backup));
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValue(structuredClone(runtimeSnapshot));
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("publishes optional runtime sections and retained backup facts", async () => {
    // Gateway/schema/default output belongs to status-json.test.ts; this owns the runtime handoff.
    const scan = createScan();
    const result = await runJson(scan, {
      ...createStatusGatewayProbeBudget(1234),
      deep: true,
      usage: true,
      agent: "beta",
      all: true,
    });
    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
        gatewayProbeDeadlineMs: 1234,
        agentId: "beta",
        usage: true,
        deep: true,
        includeSecurityAudit: true,
      }),
    );
    expect(result).toMatchObject(runtimeSnapshot);
    expect(mocks.readBackupRunFreshness).toHaveBeenCalledWith(scan.env);
    expect(result.backups).toEqual(backup);
  });

  it("records requested local inspections as not collected for online JSON", async () => {
    const scan = createScan();
    scan.collection = {
      source: "gateway",
      notCollected: [{ fields: ["memory"], reason: "local inspection skipped" }],
    };
    const result = await runJson(scan, { ...createStatusGatewayProbeBudget(), all: true });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ includeSecurityAudit: false }),
    );
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(result.securityAudit).toMatchObject({ collected: false });
    expect(result.pluginCompatibility).toEqual({
      count: 0,
      warnings: [],
      collected: false,
      reason: "Local plugin inspection is not collected in online status.",
    });
    expect(result).toMatchObject({
      collection: {
        notCollected: expect.arrayContaining([
          expect.objectContaining({ fields: ["securityAudit"] }),
        ]),
      },
    });
  });

  it("publishes full runtime policy before resolving explicit online usage", async () => {
    const sourceConfig: OpenClawConfig = {
      plugins: {
        entries: { codex: { enabled: true, config: { appServer: { homeScope: "agent" } } } },
      },
    };
    const runtimeConfig: OpenClawConfig = { ...sourceConfig, gateway: { port: 18789 } };
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({ runtimeConfig, sourceConfig });
    mocks.resolveStatusUsageSummary.mockImplementationOnce(async () => {
      expect(readRuntimeConfig().plugins).toEqual(sourceConfig.plugins);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
      return { updatedAt: 123, providers: [] };
    });
    mocks.resolveStatusRuntimeSnapshot.mockImplementationOnce(
      async (input: Parameters<typeof resolveStatusRuntimeSnapshot>[0]) => ({
        usage: await input.resolveUsage?.({
          config: input.config,
          gatewayProbeDeadlineMs: input.gatewayProbeDeadlineMs,
        }),
      }),
    );
    const scan = createScan();
    scan.collection = { source: "gateway", notCollected: [] };

    const result = await runJson(scan, { ...createStatusGatewayProbeBudget(), usage: true });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveStatusUsageSummary).toHaveBeenCalledOnce();
    expect(result.usage).toEqual({ updatedAt: 123, providers: [] });
  });

  it("skips optional sections when flags are off", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      ...runtimeSnapshot,
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
    });

    const { env: _env, ...scanWithoutEnv } = createScan();
    const result = await runJson(scanWithoutEnv, {
      ...createStatusGatewayProbeBudget(500),
      deep: false,
      usage: false,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith(
      runtimeInput(500, { usage: false, deep: false }),
    );
    expect(mocks.readBackupRunFreshness).toHaveBeenCalledWith({});
    expect(result.gateway).toMatchObject({ url: "ws://127.0.0.1:18789", urlSource: "config" });
    expect(result.gatewayService).toStrictEqual({ label: "LaunchAgent" });
    expect(result.nodeService).toStrictEqual({ label: "node" });
    for (const field of [
      "securityAudit",
      "usage",
      "health",
      "lastHeartbeat",
      "pluginCompatibility",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });
});
