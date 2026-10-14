import type { DatabaseSync } from "node:sqlite";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { ensureOpenClawAgentProgressCardSchemaInTransaction } from "../state/openclaw-agent-progress-card-schema.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { normalizeProgressCardWrite } from "./progress-card-values.js";

type ProgressCardDatabase = Pick<OpenClawAgentKyselyDatabase, "session_progress_cards">;
type StoredProgressCardRow = Selectable<ProgressCardDatabase["session_progress_cards"]>;

function selectProgressCard(db: DatabaseSync, sessionKey: string): StoredProgressCardRow | null {
  const kysely = getNodeSqliteKysely<ProgressCardDatabase>(db);
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_progress_cards")
        .select(["session_key", "markdown", "steps_json", "revision", "created_at", "updated_at"])
        .where("session_key", "=", sessionKey)
        .limit(1),
    ) ?? null
  );
}

function clearProgressCardInTransaction(
  db: DatabaseSync,
  sessionKey: string,
  expectedRevision?: number,
): boolean {
  const query = getNodeSqliteKysely<ProgressCardDatabase>(db)
    .updateTable("session_progress_cards")
    .set((eb) => ({
      markdown: null,
      steps_json: null,
      revision: eb("revision", "+", 1),
      updated_at: Date.now(),
    }))
    .where("session_key", "=", sessionKey);
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      (expectedRevision === undefined
        ? query
        : query
            .where("revision", "=", expectedRevision)
            .where((eb) =>
              eb.or([eb("markdown", "is not", null), eb("steps_json", "is not", null)]),
            )
      ).returning(["revision", "created_at"]),
    ) !== undefined
  );
}

function rowToProgressCard(row: StoredProgressCardRow): ProgressCard | null {
  const steps = row.steps_json ? readStoredSteps(row.steps_json) : undefined;
  if (!row.markdown && !steps?.length) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.markdown ? { markdown: row.markdown } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
  };
}

function readStoredSteps(value: string): ProgressCardStep[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("stored progress-card steps are not an array");
  }
  return parsed.map((entry, index) => {
    const record = asOptionalObjectRecord(entry);
    if (!record) {
      throw new Error(`stored progress-card step ${index} is invalid`);
    }
    const { step, status } = record;
    if (
      typeof step !== "string" ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      throw new Error(`stored progress-card step ${index} is invalid`);
    }
    return { step, status };
  });
}

export function readSessionProgressCard(db: DatabaseSync, sessionKey: string): ProgressCard | null {
  if (!tableExists(db, "session_progress_cards")) {
    return null;
  }
  const row = selectProgressCard(db, sessionKey);
  return row ? rowToProgressCard(row) : null;
}

/** Retain revision tombstones, but keep never-used lazy storage dormant during reset. */
export function clearSessionProgressCardForReset(db: DatabaseSync, sessionKey: string): boolean {
  if (!tableExists(db, "session_progress_cards")) {
    return false;
  }
  return db.isTransaction
    ? clearProgressCardInTransaction(db, sessionKey)
    : runSqliteImmediateTransactionSync(db, () => clearProgressCardInTransaction(db, sessionKey), {
        operationLabel: "progress-card.reset",
      });
}

export function writeSessionProgressCard(
  db: DatabaseSync,
  sessionKey: string,
  input: { markdown?: string; steps?: ProgressCardStep[]; expectedRevision?: number },
): { card: ProgressCard | null } | { cleared: true } {
  return writePreparedSessionProgressCard(db, sessionKey, prepareSessionProgressCardWrite(input));
}

export function prepareSessionProgressCardWrite(input: {
  markdown?: string;
  steps?: ProgressCardStep[];
  expectedRevision?: number;
}) {
  const { markdown, steps } = normalizeProgressCardWrite(input);
  return {
    markdown,
    steps,
    stepsJson: steps ? JSON.stringify(steps) : null,
    expectedRevision: input.expectedRevision,
  };
}

export function writePreparedSessionProgressCard(
  db: DatabaseSync,
  sessionKey: string,
  input: ReturnType<typeof prepareSessionProgressCardWrite>,
): { card: ProgressCard | null } | { cleared: true } {
  const write = (): { card: ProgressCard | null } | { cleared: true } => {
    ensureOpenClawAgentProgressCardSchemaInTransaction(db);
    const kysely = getNodeSqliteKysely<ProgressCardDatabase>(db);
    const { markdown, steps, stepsJson } = input;
    if (!markdown && !steps) {
      if (
        !clearProgressCardInTransaction(db, sessionKey, input.expectedRevision) &&
        input.expectedRevision !== undefined
      ) {
        return { card: readSessionProgressCard(db, sessionKey) };
      }
      return { cleared: true };
    }
    const now = Date.now();
    const written = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .insertInto("session_progress_cards")
        .values({
          session_key: sessionKey,
          markdown: markdown ?? null,
          steps_json: stepsJson,
          revision: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet((eb) => ({
            markdown: markdown ?? null,
            steps_json: stepsJson,
            revision: eb("session_progress_cards.revision", "+", 1),
            updated_at: now,
          })),
        )
        .returning(["revision", "created_at"]),
    );
    return {
      card: {
        sessionKey,
        revision: written!.revision,
        updatedAt: now,
        ...(markdown ? { markdown } : {}),
        ...(steps ? { steps } : {}),
      },
    };
  };
  return db.isTransaction
    ? write()
    : runSqliteImmediateTransactionSync(db, write, {
        operationLabel: "progress-card.write",
      });
}
