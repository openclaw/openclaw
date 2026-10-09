// Canonical SQLite row helpers for exec approval policy state.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { sha256Hex } from "./crypto-digest.js";
import { formatErrorMessage } from "./errors.js";
import {
  createFailClosedExecApprovalsFallback,
  LEGACY_EXEC_APPROVALS_DIAGNOSTIC,
  normalizeExecApprovalsInternal,
  parsePersistedExecApprovals,
  resolveExecApprovalsDisplayPath,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  ExecApprovalsMigrationRequiredError,
  resetExecApprovalsMigrationGateForTest,
} from "./exec-approvals-migration-gate.js";
import { assertExecApprovalsHostPolicyUnchanged } from "./exec-approvals-policy.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const EXEC_APPROVALS_CONFIG_KEY = "current";

type ExecApprovalsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_deletion_journal" | "exec_approvals_config"
>;

export class ExecApprovalsMutationFencedError extends Error {
  constructor() {
    super("Exec approvals cannot be changed while agent deletion is in progress; retry.");
    this.name = "ExecApprovalsMutationFencedError";
  }
}

export function assertExecApprovalsMutationAllowed(params: {
  db: DatabaseSync;
  current: ExecApprovalsFile;
  next: ExecApprovalsFile;
}): void {
  const current = normalizeExecApprovalsInternal(params.current);
  const next = normalizeExecApprovalsInternal(params.next);
  const changed = [
    ...new Set([...Object.keys(current.agents ?? {}), ...Object.keys(next.agents ?? {})]),
  ].filter((agentId) => !isDeepStrictEqual(current.agents?.[agentId], next.agents?.[agentId]));
  const agentIds = new Set(changed.map(normalizeAgentId));
  if (agentIds.size === 0) {
    return;
  }
  const journal = executeSqliteQueryTakeFirstSync(
    params.db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(params.db)
      .selectFrom("agent_deletion_journal")
      .select("agent_id")
      .where("agent_id", "in", [...agentIds])
      .limit(1),
  );
  if (journal) {
    throw new ExecApprovalsMutationFencedError();
  }
}

type ExecApprovalsConfigRow = {
  raw_json: string;
};

function hashExecApprovalsRaw(raw: string | null): string {
  return raw === null ? `missing:${sha256Hex("")}` : sha256Hex(raw);
}

export function serializeExecApprovals(file: ExecApprovalsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function readExecApprovalsConfigRow(db: DatabaseSync): ExecApprovalsConfigRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(db)
      .selectFrom("exec_approvals_config")
      .select("raw_json")
      .where("config_key", "=", EXEC_APPROVALS_CONFIG_KEY),
  );
}

export function snapshotFromExecApprovalsRow(params: {
  path: string;
  row?: ExecApprovalsConfigRow;
  onMalformed?: () => void;
}): ExecApprovalsSnapshot {
  const raw = params.row?.raw_json ?? null;
  if (raw === null) {
    return {
      path: params.path,
      exists: false,
      raw: null,
      file: normalizeExecApprovalsInternal({ version: 1, agents: {} }),
      hash: hashExecApprovalsRaw(null),
    };
  }
  const result = parsePersistedExecApprovals(raw);
  if (!result.ok && result.error === LEGACY_EXEC_APPROVALS_DIAGNOSTIC) {
    throw new ExecApprovalsMigrationRequiredError(params.path, undefined, result.error);
  }
  const parsed = result.ok ? result.value : null;
  if (!parsed) {
    params.onMalformed?.();
  }
  return {
    path: params.path,
    exists: true,
    raw,
    file: parsed ?? createFailClosedExecApprovalsFallback(),
    hash: hashExecApprovalsRaw(raw),
  };
}

export function projectionValues(file: ExecApprovalsFile) {
  const normalized = normalizeExecApprovalsInternal(file);
  const agents = Object.values(normalized.agents ?? {});
  return {
    socket_path: normalized.socket?.path ?? null,
    has_socket_token: normalized.socket?.token ? 1 : 0,
    default_security: normalized.defaults?.security ?? null,
    default_ask: normalized.defaults?.ask ?? null,
    default_ask_fallback: normalized.defaults?.askFallback ?? null,
    auto_allow_skills:
      normalized.defaults?.autoAllowSkills === undefined
        ? null
        : normalized.defaults.autoAllowSkills
          ? 1
          : 0,
    agent_count: agents.length,
    allowlist_count: agents.reduce((total, agent) => total + (agent.allowlist?.length ?? 0), 0),
  };
}

export function writeExecApprovalsConfigRow(params: {
  db: DatabaseSync;
  file: ExecApprovalsFile;
  raw?: string;
  now?: number;
}): string {
  const normalized = normalizeExecApprovalsInternal(params.file);
  const authored = params.raw ?? serializeExecApprovals(params.file);
  const parsed = parsePersistedExecApprovals(authored);
  // Malformed policy must remain visible to the fail-closed reader, not become partial defaults.
  const raw =
    params.raw ??
    (!parsed.ok && parsed.error === LEGACY_EXEC_APPROVALS_DIAGNOSTIC
      ? serializeExecApprovals(normalized)
      : authored);
  const values = {
    raw_json: raw,
    ...projectionValues(normalized),
    updated_at_ms: params.now ?? Date.now(),
  };
  executeSqliteQuerySync(
    params.db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(params.db)
      .insertInto("exec_approvals_config")
      .values({ config_key: EXEC_APPROVALS_CONFIG_KEY, ...values })
      .onConflict((conflict) => conflict.column("config_key").doUpdateSet(values)),
  );
  return raw;
}

export function deleteExecApprovalsConfigRow(db: DatabaseSync): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(db)
      .deleteFrom("exec_approvals_config")
      .where("config_key", "=", EXEC_APPROVALS_CONFIG_KEY),
  );
}

/** Called only inside the approval owner's winning resolution transaction. */
export function mintMcpToolGrantLocked(
  db: DatabaseSync,
  grant: { agentId: string; server: string; tool: string },
  nowMs: number,
): void {
  const row = readExecApprovalsConfigRow(db);
  const current: ExecApprovalsFile | null = row
    ? tryParsePersistedExecApprovals(row.raw_json)
    : { version: 1 };
  if (!current) {
    throw new Error("Cannot save MCP tool grant: invalid exec approvals document");
  }
  const agent = current.agents?.[grant.agentId];
  if (
    agent?.mcpTools?.some((entry) => entry.server === grant.server && entry.tool === grant.tool)
  ) {
    return;
  }
  const next = {
    ...current,
    agents: {
      ...current.agents,
      [grant.agentId]: {
        ...agent,
        mcpTools: [
          ...(agent?.mcpTools ?? []),
          {
            server: grant.server,
            tool: grant.tool,
            source: "allow-always" as const,
            addedAt: nowMs,
          },
        ],
      },
    },
  };
  assertExecApprovalsHostPolicyUnchanged(current, next);
  assertExecApprovalsMutationAllowed({ db, current, next });
  writeExecApprovalsConfigRow({ db, file: next, now: nowMs });
}

const log = createSubsystemLogger("infra/exec-approvals");
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt: number | undefined;

export function warnFailClosed(message: string, error?: unknown): void {
  const now = Date.now();
  if (lastWarnAt !== undefined && now - lastWarnAt < WARN_INTERVAL_MS) {
    return;
  }
  lastWarnAt = now;
  log.warn(message, error === undefined ? undefined : { error: formatErrorMessage(error) });
}

export function snapshotFromExecApprovalsDatabase(
  db: DatabaseSync,
  displayPath = resolveExecApprovalsDisplayPath(),
): ExecApprovalsSnapshot {
  return snapshotFromExecApprovalsRow({
    path: displayPath,
    row: readExecApprovalsConfigRow(db),
    onMalformed: () =>
      warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  Object.assign(globalThis, {
    [Symbol.for("openclaw.execApprovalsStoreTestApi")]: {
      reset(): void {
        resetExecApprovalsMigrationGateForTest();
        lastWarnAt = undefined;
      },
    },
  });
}
