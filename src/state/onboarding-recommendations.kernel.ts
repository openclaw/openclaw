import type { DatabaseSync } from "node:sqlite";
import {
  deleteConfigMachineState,
  updateConfigMachineState,
} from "./config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import {
  OnboardingRecommendationMatchesSchema,
  type OnboardingRecommendationsRecord,
  type PreparedOnboardingRecommendationOffer,
  type AcknowledgeOnboardingRecommendationsParams,
  type PreparedOnboardingRecommendationPending,
  type ClearPendingOnboardingRecommendationsParams,
} from "./onboarding-recommendations.contract.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "./worker-operation-registry.js";

export function readOnboardingRecommendationsInDatabase(
  db: DatabaseSync,
  configKey: string,
): OnboardingRecommendationsRecord | null {
  const row = readConfigMachineStateRowInDatabase(db, configKey);
  // SAFETY: The mutation kernels below own this persisted record shape; matches are validated next.
  const record = row ? (JSON.parse(row.value_json) as OnboardingRecommendationsRecord) : null;
  return record
    ? { ...record, matches: OnboardingRecommendationMatchesSchema.parse(record.matches) }
    : null;
}

function matchesExpectedOnboardingRecommendations(
  current: OnboardingRecommendationsRecord,
  expected: OnboardingRecommendationsRecord,
): boolean {
  return (
    current.inventoryHash === expected.inventoryHash &&
    JSON.stringify(current.matches) === JSON.stringify(expected.matches) &&
    current.offeredAt === expected.offeredAt &&
    current.acceptedAt === expected.acceptedAt &&
    current.updatedAt === expected.updatedAt
  );
}

function writeOnboardingRecommendationsOffer(
  configKey: string,
  params: PreparedOnboardingRecommendationOffer,
  databaseOptions: OpenClawStateDatabaseOptions,
): OnboardingRecommendationsRecord {
  const nowMs = params.nowMs;
  const inventoryHash = params.inventoryHash;
  const matches = params.matches;
  const acceptedAt = params.answered ? nowMs : null;
  return updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      // Once the user answers, concurrent or stale offer completions must not
      // clear acceptance and make later onboarding runs ask again.
      if (typeof existing?.acceptedAt === "number") {
        return existing;
      }
      return {
        inventoryHash,
        matches,
        offeredAt: nowMs,
        acceptedAt,
        updatedAt: nowMs,
      };
    },
    databaseOptions,
  );
}

function acknowledgeOnboardingRecommendations(
  configKey: string,
  params: AcknowledgeOnboardingRecommendationsParams,
  databaseOptions: OpenClawStateDatabaseOptions,
): OnboardingRecommendationsRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  let acknowledged: OnboardingRecommendationsRecord | null = null;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (!existing) {
        return undefined;
      }
      if (params.expected && !matchesExpectedOnboardingRecommendations(existing, params.expected)) {
        return existing;
      }
      acknowledged =
        typeof existing.acceptedAt === "number"
          ? existing
          : { ...existing, acceptedAt: nowMs, updatedAt: nowMs };
      return acknowledged;
    },
    databaseOptions,
  );
  return acknowledged;
}

function updatePendingOnboardingRecommendations(
  configKey: string,
  params: PreparedOnboardingRecommendationPending,
  databaseOptions: OpenClawStateDatabaseOptions,
): OnboardingRecommendationsRecord | null {
  const nowMs = params.nowMs;
  const matches = params.matches;
  let updated: OnboardingRecommendationsRecord | null = null;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (
        !existing ||
        typeof existing.acceptedAt === "number" ||
        !matchesExpectedOnboardingRecommendations(existing, params.expected)
      ) {
        return existing;
      }
      updated = { ...existing, matches, updatedAt: nowMs };
      return updated;
    },
    databaseOptions,
  );
  return updated;
}

function clearPendingOnboardingRecommendations(
  configKey: string,
  params: ClearPendingOnboardingRecommendationsParams,
  databaseOptions: OpenClawStateDatabaseOptions,
): boolean {
  let cleared = false;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (
        !existing ||
        existing.acceptedAt !== null ||
        !matchesExpectedOnboardingRecommendations(existing, params.expected)
      ) {
        return existing;
      }
      cleared = true;
      return undefined;
    },
    databaseOptions,
  );
  return cleared;
}

function recommendationOperation<Params, Result>(
  operation: (configKey: string, params: Params, options: OpenClawStateDatabaseOptions) => Result,
) {
  return (
    { configKey, params }: { configKey: string; params: Params },
    { open, stateOptions }: WorkerOperationContext,
  ) => operation(configKey, params, { database: open(), ...stateOptions() });
}

export const onboardingRecommendationOperations = {
  "onboardingRecommendations.writeOffer": recommendationOperation(
    writeOnboardingRecommendationsOffer,
  ),
  "onboardingRecommendations.acknowledge": recommendationOperation(
    acknowledgeOnboardingRecommendations,
  ),
  "onboardingRecommendations.updatePending": recommendationOperation(
    updatePendingOnboardingRecommendations,
  ),
  "onboardingRecommendations.clearPending": recommendationOperation(
    clearPendingOnboardingRecommendations,
  ),
  "onboardingRecommendations.clear": (
    { configKey }: { configKey: string },
    { open, stateOptions },
  ) => deleteConfigMachineState(configKey, { database: open(), ...stateOptions() }),
} satisfies WorkerOperationHandlers;

export type OnboardingRecommendationWriteOperations = WorkerOperations<
  typeof onboardingRecommendationOperations
>;
