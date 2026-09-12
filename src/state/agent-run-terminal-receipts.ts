import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { AgentRunTerminalReceipts } from "./openclaw-state-db.generated.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { ensureAgentRunTerminalReceiptSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

export const AGENT_RUN_TERMINAL_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const AGENT_RUN_TERMINAL_RECEIPT_MAX_ROWS = 5_000;
export const AGENT_RUN_TERMINAL_RECEIPT_MAX_JSON_BYTES = 64 * 1_024;

export class AgentRunTerminalReceiptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunTerminalReceiptValidationError";
  }
}

type AgentRunTerminalReceiptDatabase = {
  agent_run_terminal_receipts: AgentRunTerminalReceipts;
};

export type AgentRunTerminalReceiptOwner = {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export type AgentRunTerminalReceipt = {
  runId: string;
  owner: AgentRunTerminalReceiptOwner;
  terminalJson: string;
  createdAt: number;
  expiresAt: number;
};

export type AgentRunTerminalReceiptWriteResult =
  | { state: "written" }
  | { state: "retained" }
  | { state: "owner-conflict" };

type AgentRunTerminalReceiptWriteParams = {
  runId: string;
  owner: AgentRunTerminalReceiptOwner;
  terminalJson: string;
  replaceProvisionalDelivery?: boolean;
  now?: number;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
};

function validateRunId(runId: string): string {
  if (runId.length === 0) {
    throw new AgentRunTerminalReceiptValidationError("runId must not be empty");
  }
  return runId;
}

function normalizeRequiredText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AgentRunTerminalReceiptValidationError(
      `${name} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

function normalizeOwner(owner: AgentRunTerminalReceiptOwner): AgentRunTerminalReceiptOwner {
  return {
    agentId: normalizeRequiredText(owner.agentId, "agentId", 128),
    ...(owner.sessionKey === undefined
      ? {}
      : { sessionKey: normalizeRequiredText(owner.sessionKey, "sessionKey", 1_024) }),
    ...(owner.sessionId === undefined
      ? {}
      : { sessionId: normalizeRequiredText(owner.sessionId, "sessionId", 256) }),
  };
}

function isValidTerminalJson(terminalJson: string): boolean {
  if (
    Buffer.byteLength(terminalJson, "utf8") < 2 ||
    Buffer.byteLength(terminalJson, "utf8") > AGENT_RUN_TERMINAL_RECEIPT_MAX_JSON_BYTES
  ) {
    return false;
  }
  try {
    const decoded = JSON.parse(terminalJson) as unknown;
    return Boolean(decoded && typeof decoded === "object" && !Array.isArray(decoded));
  } catch {
    return false;
  }
}

function validateTerminalJson(terminalJson: string): string {
  if (!isValidTerminalJson(terminalJson)) {
    throw new AgentRunTerminalReceiptValidationError(
      `terminalJson must encode an object within ${AGENT_RUN_TERMINAL_RECEIPT_MAX_JSON_BYTES} UTF-8 bytes`,
    );
  }
  return terminalJson;
}

function isProvisionalDeliveryTerminalJson(terminalJson: string): boolean {
  try {
    // SAFETY: JSON.parse returns an untyped value; only a strict false marker is consumed below.
    const decoded = JSON.parse(terminalJson) as { executionSettled?: unknown };
    return decoded.executionSettled === false;
  } catch {
    return false;
  }
}

function ownerMatches(
  row: Pick<AgentRunTerminalReceipts, "agent_id" | "session_key" | "session_id">,
  owner: AgentRunTerminalReceiptOwner,
): boolean {
  return (
    row.agent_id === owner.agentId &&
    row.session_key === (owner.sessionKey ?? null) &&
    row.session_id === (owner.sessionId ?? null)
  );
}

function deleteInvalidReceiptBestEffort(runId: string, env?: NodeJS.ProcessEnv): void {
  try {
    deleteAgentRunTerminalReceipt({ runId, env });
  } catch {
    // A malformed receipt is always a miss; a later write/read can retry pruning it.
  }
}

/**
 * First execution terminal wins. An exact owner may promote its provisional
 * delivery receipt once execution settles; expired and excess rows are pruned
 * in the same transaction.
 */
export function writeAgentRunTerminalReceiptWithResult(
  params: AgentRunTerminalReceiptWriteParams,
): AgentRunTerminalReceiptWriteResult {
  const runId = validateRunId(params.runId);
  const owner = normalizeOwner(params.owner);
  const terminalJson = validateTerminalJson(params.terminalJson);
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? AGENT_RUN_TERMINAL_RECEIPT_TTL_MS;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new AgentRunTerminalReceiptValidationError(
      "terminal receipt timestamps must be non-negative safe integers",
    );
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new AgentRunTerminalReceiptValidationError(
      "terminal receipt expiry exceeds the safe integer range",
    );
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentRunTerminalReceiptSchema(database.db);
      const db = getNodeSqliteKysely<AgentRunTerminalReceiptDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_run_terminal_receipts").where("expires_at_ms", "<=", now),
      );
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("agent_run_terminal_receipts").selectAll().where("run_id", "=", runId),
      );
      let result: AgentRunTerminalReceiptWriteResult;
      if (existing && !ownerMatches(existing, owner)) {
        result = { state: "owner-conflict" };
      } else if (
        existing &&
        params.replaceProvisionalDelivery === true &&
        isProvisionalDeliveryTerminalJson(existing.terminal_json)
      ) {
        const updated = executeSqliteQuerySync(
          database.db,
          db
            .updateTable("agent_run_terminal_receipts")
            .set({ terminal_json: terminalJson, created_at_ms: now, expires_at_ms: expiresAt })
            .where("run_id", "=", runId),
        );
        result =
          (updated.numAffectedRows ?? 0n) > 0n ? { state: "written" } : { state: "retained" };
      } else if (existing) {
        result = { state: "retained" };
      } else {
        const inserted = executeSqliteQuerySync(
          database.db,
          db.insertInto("agent_run_terminal_receipts").values({
            run_id: runId,
            agent_id: owner.agentId,
            session_key: owner.sessionKey ?? null,
            session_id: owner.sessionId ?? null,
            terminal_json: terminalJson,
            created_at_ms: now,
            expires_at_ms: expiresAt,
          }),
        );
        result =
          (inserted.numAffectedRows ?? 0n) > 0n ? { state: "written" } : { state: "retained" };
      }
      const excessRunIds = db
        .selectFrom("agent_run_terminal_receipts")
        .select("run_id")
        .orderBy("created_at_ms", "desc")
        .orderBy("run_id", "desc")
        .limit(-1)
        .offset(AGENT_RUN_TERMINAL_RECEIPT_MAX_ROWS);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_run_terminal_receipts").where("run_id", "in", excessRunIds),
      );
      return result;
    },
    { env: params.env },
    { operationLabel: "agent-run-terminal-receipt.write" },
  );
}

export function writeAgentRunTerminalReceipt(params: AgentRunTerminalReceiptWriteParams): boolean {
  return writeAgentRunTerminalReceiptWithResult(params).state === "written";
}

/** Reads only live, valid receipts and optionally requires an exact trusted owner tuple. */
export function readAgentRunTerminalReceipt(params: {
  runId: string;
  owner?: AgentRunTerminalReceiptOwner;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): AgentRunTerminalReceipt | undefined {
  const runId = validateRunId(params.runId);
  const owner = params.owner ? normalizeOwner(params.owner) : undefined;
  const now = params.now ?? Date.now();
  const row = withExistingOpenClawStateDatabaseReadOnly(
    ({ db: database }) => {
      if (!tableExists(database, "agent_run_terminal_receipts")) {
        return undefined;
      }
      const db = getNodeSqliteKysely<AgentRunTerminalReceiptDatabase>(database);
      return executeSqliteQueryTakeFirstSync(
        database,
        db.selectFrom("agent_run_terminal_receipts").selectAll().where("run_id", "=", runId),
      );
    },
    { env: params.env },
  );
  if (!row) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(row.created_at_ms) ||
    !Number.isSafeInteger(row.expires_at_ms) ||
    row.expires_at_ms <= now ||
    !isValidTerminalJson(row.terminal_json)
  ) {
    deleteInvalidReceiptBestEffort(runId, params.env);
    return undefined;
  }
  if (owner && !ownerMatches(row, owner)) {
    return undefined;
  }
  return {
    runId: row.run_id,
    owner: {
      agentId: row.agent_id,
      ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    },
    terminalJson: row.terminal_json,
    createdAt: row.created_at_ms,
    expiresAt: row.expires_at_ms,
  };
}

/** Removes any stale terminal fact before a newly admitted owner reuses a run id. */
export function deleteAgentRunTerminalReceipt(params: {
  runId: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const runId = validateRunId(params.runId);
  return runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentRunTerminalReceiptSchema(database.db);
      const db = getNodeSqliteKysely<AgentRunTerminalReceiptDatabase>(database.db);
      const deleted = executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_run_terminal_receipts").where("run_id", "=", runId),
      );
      return (deleted.numAffectedRows ?? 0n) > 0n;
    },
    { env: params.env },
    { operationLabel: "agent-run-terminal-receipt.delete" },
  );
}
