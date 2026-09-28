import type { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
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
  type OnboardingRecommendationWriteOperations,
} from "./onboarding-recommendations.contract.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

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
  databaseOptions: OpenClawStateDatabaseOptions = {},
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
  params: AcknowledgeOnboardingRecommendationsParams = {},
  databaseOptions: OpenClawStateDatabaseOptions = {},
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
  databaseOptions: OpenClawStateDatabaseOptions = {},
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
  databaseOptions: OpenClawStateDatabaseOptions = {},
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

export function executeOnboardingRecommendationCommand(
  command: SqliteWorkerCommand<OnboardingRecommendationWriteOperations>,
  database: OpenClawStateDatabaseOptions,
): OnboardingRecommendationWriteOperations[keyof OnboardingRecommendationWriteOperations]["output"] {
  switch (command.type) {
    case "onboardingRecommendations.writeOffer":
      return writeOnboardingRecommendationsOffer(
        command.input.configKey,
        command.input.params,
        database,
      );
    case "onboardingRecommendations.acknowledge":
      return acknowledgeOnboardingRecommendations(
        command.input.configKey,
        command.input.params,
        database,
      );
    case "onboardingRecommendations.updatePending":
      return updatePendingOnboardingRecommendations(
        command.input.configKey,
        command.input.params,
        database,
      );
    case "onboardingRecommendations.clearPending":
      return clearPendingOnboardingRecommendations(
        command.input.configKey,
        command.input.params,
        database,
      );
    case "onboardingRecommendations.clear":
      return deleteConfigMachineState(command.input.configKey, database);
  }
  throw new Error("Unexpected onboarding recommendation write command");
}
