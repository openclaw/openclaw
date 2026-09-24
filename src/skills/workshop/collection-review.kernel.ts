import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { updateConfigMachineStateInDatabase } from "../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import type { OpenClawStateDatabase as StateDatabase } from "../../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";

const SKILL_COLLECTION_REVIEW_HISTORY_LIMIT = 20;
type CollectionReviewDatabase = Pick<OpenClawStateDatabase, "skill_workshop_collection_reviews">;
type SkillCuratorState = {
  lastAttemptAtMs: number;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  lastResult: {
    collectionReviews?: Record<string, SkillCollectionReviewStatus>;
    experienceReviews?: Record<string, SkillExperienceReviewStatus>;
  };
};

export type SkillCollectionReviewOutcome = SkillCollectionReviewResult & { createTime: number };

type SkillCollectionReviewResult = {
  backupId: string;
  kept: string[];
  written: string[];
  dropped: Array<{ name: string; reason: string }>;
};

type SkillCollectionReviewStatus = {
  attemptedAtMs: number;
  succeededAtMs?: number;
  error?: string;
};

export type SkillExperienceReviewStatus = {
  attemptedAtMs: number;
  /** Completed normal maintenance does not claim that any particular file changed. */
  outcome: "completed" | "applied" | "proposed" | "nothing" | "failed";
  proposalId?: string;
  error?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};

function experienceReviewKey(agentId: string, workspaceDir: string): string {
  return sha256Hex(`${agentId}\0${path.resolve(workspaceDir)}`);
}

export function readSkillCuratorReviewStatusInDatabase(database: StateDatabase) {
  const state = readConfigMachineState<SkillCuratorState>("skills.curatorState", { database });
  return {
    lastAttemptAtMs: state?.lastAttemptAtMs ?? null,
    lastSuccessAtMs: state?.lastSuccessAtMs ?? null,
    lastError: state?.lastError ?? null,
    collectionReviews: state?.lastResult.collectionReviews ?? {},
    experienceReviews: state?.lastResult.experienceReviews ?? {},
  };
}

export type RecordSkillExperienceReviewOutcomeInput = {
  agentId: string;
  workspaceDir: string;
  review: SkillExperienceReviewStatus;
};

export function recordSkillExperienceReviewOutcomeInDatabase(
  database: StateDatabase,
  input: RecordSkillExperienceReviewOutcomeInput,
): void {
  const entryKey = experienceReviewKey(input.agentId, input.workspaceDir);
  const now = Date.now();
  updateConfigMachineStateInDatabase<SkillCuratorState>(
    database.db,
    "skills.curatorState",
    (current) => {
      const state = current?.lastResult;
      return {
        lastAttemptAtMs: 0,
        lastSuccessAtMs: null,
        lastError: null,
        ...current,
        lastResult: {
          ...state,
          experienceReviews: {
            ...state?.experienceReviews,
            [entryKey]: input.review,
          },
        },
      };
    },
    now,
  );
}

function parseStoredNames(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`Invalid ${field} in stored skill collection review.`);
  }
  return parsed;
}

function parseStoredDrops(value: string): SkillCollectionReviewResult["dropped"] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid dropped entries in stored skill collection review.");
  }
  return parsed.map((entry) => {
    const record = asNullableRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.reason !== "string") {
      throw new Error("Invalid dropped entry in stored skill collection review.");
    }
    return { name: record.name, reason: record.reason };
  });
}

export type ReadSkillCollectionBackupDropsInput = { agentId: string; backupId: string };

export function readSkillCollectionBackupDropsInDatabase(
  database: DatabaseSync,
  input: ReadSkillCollectionBackupDropsInput,
): Set<string> {
  const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    kysely
      .selectFrom("skill_workshop_collection_reviews")
      .select("dropped_json")
      .where("owner_agent_id", "=", input.agentId)
      .where("backup_id", "=", input.backupId),
  ).rows;
  return new Set(
    rows.flatMap((row) => parseStoredDrops(row.dropped_json).map((drop) => drop.name)),
  );
}

export function listSkillCollectionReviewOutcomesInDatabase(
  database: DatabaseSync,
  agentId: string,
): SkillCollectionReviewOutcome[] {
  const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(database);
  return executeSqliteQuerySync(
    database,
    kysely
      .selectFrom("skill_workshop_collection_reviews")
      .select(["backup_id", "create_time", "kept_names_json", "written_names_json", "dropped_json"])
      .where("owner_agent_id", "=", agentId)
      .orderBy("create_time", "desc")
      .orderBy("review_id", "desc")
      .limit(SKILL_COLLECTION_REVIEW_HISTORY_LIMIT),
  ).rows.map((row) => ({
    createTime: row.create_time,
    backupId: row.backup_id,
    kept: parseStoredNames(row.kept_names_json, "kept names"),
    written: parseStoredNames(row.written_names_json, "written names"),
    dropped: parseStoredDrops(row.dropped_json),
  }));
}
