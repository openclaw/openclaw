import { isDeepStrictEqual } from "node:util";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { ensureOpenClawAgentProgressCardSchemaInTransaction } from "../state/openclaw-agent-progress-card-schema.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { ProgressCardInputError } from "./progress-card-input.js";
import type { ProgressCardWrite } from "./progress-card-values.js";
import { normalizeProgressCardWrite } from "./progress-card-values.js";
import { progressWorkCommandForIntent } from "./progress-card-work-intent.js";
import {
  assertProgressWorkFence,
  decodeProgressWorkRecord,
  presentSessionProgress,
  reconcileSessionProgress,
  transferProgressWork,
  retireProgressWork,
  type ProgressOwner,
  type ProgressAggregate,
  type ProgressWorkState,
  type ProgressWorkCommand,
} from "./progress-card-work.js";

type ProgressCardDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_progress_cards" | "session_nodes"
>;
type StoredProgressCardRow = Selectable<ProgressCardDatabase["session_progress_cards"]>;

// Reads stay in transcript/progress workers or the existing lifecycle writer transaction.
function selectProgressCard(
  db: EngineConnection,
  sessionKey: string,
): StoredProgressCardRow | null {
  const kysely = getNodeSqliteKysely<ProgressCardDatabase>(db);
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_progress_cards")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .limit(1),
    ) ?? null
  );
}

function clearProgressCardInTransaction(
  db: EngineConnection,
  sessionKey: string,
  expectedRevision?: number,
  retireWork = false,
): boolean {
  const query = getNodeSqliteKysely<ProgressCardDatabase>(db)
    .updateTable("session_progress_cards")
    .set((eb) => ({
      markdown: null,
      steps_json: null,
      ...(tableHasColumn(db, "session_progress_cards", "display_kind")
        ? { display_kind: "independent" }
        : {}),
      ...(retireWork && tableHasColumn(db, "session_progress_cards", "work_revision")
        ? {
            work_revision: eb("work_revision", "+", 1),
          }
        : {}),
      ...(retireWork && tableHasColumn(db, "session_progress_cards", "work_json")
        ? { work_json: null }
        : {}),
      ...(retireWork && tableHasColumn(db, "session_progress_cards", "work_command_json")
        ? { work_command_json: null }
        : {}),
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
              eb.or([
                eb("markdown", "is not", null),
                eb("steps_json", "is not", null),
                ...(tableHasColumn(db, "session_progress_cards", "display_kind")
                  ? [eb("display_kind", "=", "work")]
                  : []),
              ]),
            )
      ).returning(["revision", "created_at"]),
    ) !== undefined
  );
}

function rowToProgressCard(row: StoredProgressCardRow): ProgressCard | null {
  if (
    row.display_kind !== undefined &&
    row.display_kind !== "work" &&
    row.display_kind !== "independent"
  ) {
    throw new ProgressCardInputError("Invalid progress display selection");
  }
  const steps =
    row.display_kind === "work"
      ? decodeProgressWorkRecord(row.work_json)?.steps
      : row.steps_json
        ? readStoredSteps(row.steps_json)
        : undefined;
  if (row.display_kind === "work" && !steps) {
    throw new ProgressCardInputError("Progress display has no retained work");
  }
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

export function readSessionProgressCard(
  db: EngineConnection,
  sessionKey: string,
): ProgressCard | null {
  if (!tableExists(db, "session_progress_cards")) {
    return null;
  }
  const row = selectProgressCard(db, sessionKey);
  return row ? rowToProgressCard(row) : null;
}

/** Retain revision tombstones, but keep never-used lazy storage dormant during reset. */
export function clearSessionProgressCardForReset(
  db: EngineConnection,
  sessionKey: string,
): boolean {
  if (!tableExists(db, "session_progress_cards")) {
    return false;
  }
  return db.isTransaction
    ? clearProgressCardInTransaction(db, sessionKey, undefined, true)
    : runSqliteImmediateTransactionSync(
        db,
        () => clearProgressCardInTransaction(db, sessionKey, undefined, true),
        {
          operationLabel: "progress-card.reset",
        },
      );
}

export function writeSessionProgressCard(
  db: EngineConnection,
  sessionKey: string,
  input: ProgressCardWrite,
): { card: ProgressCard | null; work?: ProgressWorkState } | { cleared: true } {
  return writePreparedSessionProgressCard(db, sessionKey, prepareSessionProgressCardWrite(input));
}

export function prepareSessionProgressCardWrite(input: ProgressCardWrite) {
  const { markdown, steps } = normalizeProgressCardWrite(input);
  return {
    markdown,
    steps,
    managedWork: input.managedWork,
    workCommand: input.workCommand,
    stepsJson: steps ? JSON.stringify(steps) : null,
    expectedRevision: input.expectedRevision,
  };
}

/** Progress workers own ordinary writes; carry/retire/reset stay in lifecycle writer transactions. */
export function writePreparedSessionProgressCard(
  db: EngineConnection,
  sessionKey: string,
  input: ReturnType<typeof prepareSessionProgressCardWrite>,
): { card: ProgressCard | null; work?: ProgressWorkState } | { cleared: true } {
  const write = (): { card: ProgressCard | null; work?: ProgressWorkState } | { cleared: true } => {
    ensureOpenClawAgentProgressCardSchemaInTransaction(db);
    if (input.managedWork) {
      const current = readSessionProgressAggregate(db, sessionKey)?.work;
      const workCommand = progressWorkCommandForIntent(
        input.managedWork,
        input.managedWork.intent,
        input.steps,
      );
      if (workCommand) {
        return writeManagedSessionProgress(db, sessionKey, { ...input, workCommand });
      }
      assertProgressWorkFence(current, input.managedWork.expected);
      // A host note/clear replaces only presentation; return the retained committed work.
      assertWorkOwner(db, sessionKey, input.managedWork.owner);
      const display = writePreparedSessionProgressCard(db, sessionKey, {
        ...input,
        managedWork: undefined,
      });
      return { card: "card" in display ? display.card : null, work: current };
    }
    if (input.workCommand) {
      return writeManagedSessionProgress(db, sessionKey, {
        ...input,
        workCommand: input.workCommand,
      });
    }
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
          display_kind: "independent",
          revision: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet((eb) => ({
            markdown: markdown ?? null,
            steps_json: stepsJson,
            display_kind: "independent",
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

/** Private aggregate read; legacy columns are never upgraded by observation. */
export function readSessionProgressAggregate(
  db: EngineConnection,
  sessionKey: string,
): ProgressAggregate | undefined {
  if (!tableExists(db, "session_progress_cards")) {
    return undefined;
  }
  const row = selectProgressCard(db, sessionKey);
  if (!row) {
    return undefined;
  }
  if (
    row.display_kind !== undefined &&
    row.display_kind !== "work" &&
    row.display_kind !== "independent"
  ) {
    throw new ProgressCardInputError("Invalid progress display selection");
  }
  if (
    (row.work_generation !== undefined &&
      (!Number.isSafeInteger(row.work_generation) || row.work_generation < 0)) ||
    ((row.work_json || row.work_command_json) && !(row.work_generation > 0))
  ) {
    throw new ProgressCardInputError("Invalid retained work fence");
  }
  let work: ProgressWorkState | undefined;
  if (row.work_generation > 0) {
    if (!Number.isSafeInteger(row.work_revision) || row.work_revision < 1) {
      throw new ProgressCardInputError("Invalid retained work fence");
    }
    const last: unknown = row.work_command_json ? JSON.parse(row.work_command_json) : undefined;
    let lastCommand: ProgressWorkState["lastCommand"];
    if (last !== undefined) {
      const command = asOptionalObjectRecord(last);
      if (
        !command ||
        typeof command.id !== "string" ||
        typeof command.fingerprint !== "string" ||
        command.id.length !== 64 ||
        command.fingerprint.length !== 64
      ) {
        throw new ProgressCardInputError("Invalid retained work command");
      }
      lastCommand = { id: command.id, fingerprint: command.fingerprint };
    }
    work = {
      generation: row.work_generation,
      revision: row.work_revision,
      record: decodeProgressWorkRecord(row.work_json),
      ...(lastCommand ? { lastCommand } : {}),
    };
  }
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.markdown ? { markdown: row.markdown } : {}),
    ...(row.steps_json ? { steps: readStoredSteps(row.steps_json) } : {}),
    ...(row.display_kind === "work" ? { checklist: "work" } : {}),
    ...(work ? { work } : {}),
  };
}

export function readSessionProgressWork(db: EngineConnection, owner: ProgressOwner) {
  assertWorkOwner(db, owner.sessionKey, owner);
  return readSessionProgressAggregate(db, owner.sessionKey)?.work;
}

function assertWorkOwner(db: EngineConnection, sessionKey: string, owner: ProgressOwner) {
  const query = getNodeSqliteKysely<ProgressCardDatabase>(db);
  const node = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json"])
      .where("session_key", "=", sessionKey),
  );
  const entry = node && asOptionalObjectRecord(JSON.parse(node.entry_json));
  if (
    owner.sessionKey !== sessionKey ||
    node?.current_session_id !== owner.sessionId ||
    (entry?.lifecycleRevision ?? null) !== owner.lifecycleRevision ||
    entry?.archivedAt !== undefined
  ) {
    throw new ProgressCardInputError("Work owner incarnation is no longer current");
  }
}

function writeManagedSessionProgress(
  db: EngineConnection,
  sessionKey: string,
  input: { markdown?: string; steps?: ProgressCardStep[]; workCommand: ProgressWorkCommand },
) {
  assertWorkOwner(db, sessionKey, input.workCommand.owner);
  const current = readSessionProgressAggregate(db, sessionKey);
  const next = reconcileSessionProgress(current, input, Date.now());
  persistProgressAggregate(db, sessionKey, next);
  return { card: presentSessionProgress(sessionKey, next), work: next.work };
}

function persistProgressAggregate(
  db: EngineConnection,
  sessionKey: string,
  next: ProgressAggregate,
) {
  const query = getNodeSqliteKysely<ProgressCardDatabase>(db);
  const values = {
    markdown: next.markdown ?? null,
    steps_json: next.steps ? JSON.stringify(next.steps) : null,
    display_kind: next.checklist ?? "independent",
    revision: next.revision,
    updated_at: next.updatedAt,
    work_json: next.work?.record ? JSON.stringify(next.work.record) : null,
    work_generation: next.work?.generation ?? 0,
    work_revision: next.work?.revision ?? 0,
    work_command_json: next.work?.lastCommand ? JSON.stringify(next.work.lastCommand) : null,
  };
  executeSqliteQueryTakeFirstSync(
    db,
    query
      .insertInto("session_progress_cards")
      .values({ session_key: sessionKey, created_at: Date.now(), ...values })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(values))
      .returning("revision"),
  );
}

/** Called only inside the existing lifecycle writer transaction; reads never rebind work. */
export function carrySessionProgressWorkForReset(
  db: EngineConnection,
  previous: ProgressOwner,
  next: ProgressOwner,
): void {
  const state = readSessionProgressAggregate(db, previous.sessionKey);
  if (!state?.work?.record) {
    return;
  }
  persistProgressAggregate(db, previous.sessionKey, transferProgressWork(state, previous, next));
}

export function retireSessionProgressWorkForIncarnation(
  db: EngineConnection,
  owner: ProgressOwner,
): void {
  const state = readSessionProgressAggregate(db, owner.sessionKey);
  if (!state?.work?.record || isDeepStrictEqual(state.work.record.owner, owner)) {
    return;
  }
  persistProgressAggregate(db, owner.sessionKey, retireProgressWork(state, Date.now()));
}
