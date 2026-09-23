import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";

export function createPostUpdateRepairFixture(home: string): FinishUpdateParams {
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  return {
    mutationStarted: true,
    result: {
      status: "ok",
      mode: "npm",
      root: "/candidate",
      steps: [],
      durationMs: 1,
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
    },
    root: "/candidate",
    installKindChanged: false,
    configSnapshot: {
      path: configPath,
      exists: false,
      raw: null,
      parsed: {},
      sourceConfig: asResolvedSourceConfig({}),
      resolved: asResolvedSourceConfig({}),
      valid: true,
      runtimeConfig: asRuntimeConfig({}),
      config: asRuntimeConfig({}),
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: { json: true, run },
    ownedManagedUpdateEnv: env,
    preManagedServiceStop: {
      stopped: true,
      running: true,
      inspected: true,
      runtimeInspected: true,
      serviceEnv: env,
      serviceUpdateVerdict: {
        kind: "owned",
        root: "/candidate",
        fingerprint: "fixture",
        refreshDefinition: false,
      },
    },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    rollbackBlockedReason: "state-migrated-no-rollback",
  };
}
