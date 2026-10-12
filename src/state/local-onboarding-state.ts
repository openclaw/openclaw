// Durable local onboarding ownership; inference configuration alone does not prove setup finished.
import path from "node:path";
import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  localOnboardingStateKey,
  normalizeLocalOnboardingState,
  type LocalOnboardingState,
} from "./local-onboarding-state-shared.js";
export type { LocalOnboardingState } from "./local-onboarding-state-shared.js";
import { readConfigMachineStateAsync } from "./config-machine-state-async.js";
import { updateConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

/** Synchronous CLI onboarding inspection; runtime recovery uses the async reader below. */
export function readLocalOnboardingState(
  configPath: string,
  database: OpenClawStateDatabaseOptions = {},
): LocalOnboardingState | undefined {
  return normalizeLocalOnboardingState(
    readConfigMachineState(localOnboardingStateKey(configPath), database),
    configPath,
  );
}

/** A replaced config at the same path must never inherit another installation's receipt. */
export function readLocalOnboardingStateForConfig(
  configPath: string,
  config: Pick<OpenClawConfig, "wizard">,
  database: OpenClawStateDatabaseOptions = {},
): LocalOnboardingState | undefined {
  const securityAcknowledgedAt = config.wizard?.securityAcknowledgedAt?.trim();
  if (!securityAcknowledgedAt) {
    return undefined;
  }
  const state = readLocalOnboardingState(configPath, database);
  return state?.securityAcknowledgedAt === securityAcknowledgedAt ? state : undefined;
}

/** Claim approved setup before provisioning; failed provider probes do not claim a run. */
export function beginLocalOnboarding(params: {
  configPath: string;
  workspace: string;
  teamCoordinatorId?: string;
  securityAcknowledgedAt: string;
  replace?: boolean;
  expectedRunId?: string;
  runId: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): LocalOnboardingState {
  const securityAcknowledgedAt = params.securityAcknowledgedAt.trim();
  if (!securityAcknowledgedAt) {
    throw new Error("Local onboarding requires its persisted security acknowledgement.");
  }
  const coordinator =
    params.teamCoordinatorId === undefined
      ? undefined
      : normalizeAgentIdStrict(params.teamCoordinatorId);
  if (coordinator && !coordinator.ok) {
    throw new Error("Local onboarding requires a valid team coordinator id.");
  }
  const pending: LocalOnboardingState = {
    version: 1,
    status: "pending",
    runId: params.runId,
    configPath: path.resolve(params.configPath),
    workspace: path.resolve(params.workspace),
    ...(coordinator?.ok ? { teamCoordinatorId: coordinator.value } : {}),
    securityAcknowledgedAt,
    startedAtMs: params.nowMs ?? Date.now(),
  };
  return updateConfigMachineState<LocalOnboardingState>(
    localOnboardingStateKey(params.configPath),
    (value) => {
      const current = normalizeLocalOnboardingState(value, params.configPath);
      // Reset may replace only its previously observed receipt. A delayed
      // concurrent run must not reopen either a pending or completed owner.
      if (current && (!params.replace || current.runId !== params.expectedRunId)) {
        return current;
      }
      return pending;
    },
    params.database,
  );
}

/** Read onboarding through the shared-state worker for runtime recovery. */
export async function readLocalOnboardingStateForConfigAsync(
  configPath: string,
  config: Pick<OpenClawConfig, "wizard">,
  database: OpenClawStateDatabaseOptions = {},
): Promise<LocalOnboardingState | undefined> {
  const securityAcknowledgedAt = config.wizard?.securityAcknowledgedAt?.trim();
  if (!securityAcknowledgedAt) {
    return undefined;
  }
  const state = normalizeLocalOnboardingState(
    await readConfigMachineStateAsync(localOnboardingStateKey(configPath), database),
    configPath,
  );
  return state?.securityAcknowledgedAt === securityAcknowledgedAt ? state : undefined;
}

/** Complete only the owning run in the worker's serialized write transaction. */
export async function completeLocalOnboarding(params: {
  configPath: string;
  runId: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext(params.database);
  const { database: _database, ...input } = params;
  return (
    (await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "localOnboarding.complete", input }),
      { existingOnly: true },
    )) ?? false
  );
}
