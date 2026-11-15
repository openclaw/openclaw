import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";

export function updateResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return { status: "ok", mode: "npm", steps: [], durationMs: 1, ...overrides };
}

export function updateStep(
  name: string,
  overrides: Partial<UpdateStepResult> = {},
): UpdateStepResult {
  return { name, command: name, cwd: "/repo", durationMs: 1, exitCode: 1, ...overrides };
}

export function finishParams(
  overrides: Pick<FinishUpdateParams, "root" | "result" | "configSnapshot"> &
    Partial<FinishUpdateParams>,
): FinishUpdateParams {
  return {
    mutationStarted: true,
    installKindChanged: false,
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: {},
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 30_000,
    ...overrides,
  };
}
