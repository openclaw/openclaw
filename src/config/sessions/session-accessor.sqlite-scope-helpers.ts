// Shared query and logical-identity helpers do not resolve or open physical stores.
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "board_tabs"
  | "board_widgets"
  | "conversation_deliveries"
  | "conversations"
  | "heartbeat_outcomes"
  | "session_conversations"
  | "session_goal_operations"
  | "session_members"
  | "session_nodes"
  | "session_participants"
  | "session_pending_inputs"
  | "session_input_completions"
  | "session_progress_cards"
  | "session_reactions"
  | "session_suggestions"
  | "session_transcript_archives"
  | "session_transcript_cold_archives"
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_rewrite_watermarks"
  | "trajectory_runtime_events"
  | "transcript_event_identities"
  | "transcript_events"
> & {
  sqlite_schema: { name: string | null; type: string };
};

export type ResolvedSqliteScope = {
  agentId: string;
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  ownerStorePath?: string;
  path?: string;
  sessionKey: string;
};

export type ResolvedSqliteReadScope = Omit<ResolvedSqliteScope, "sessionKey"> & {
  sessionKey?: string;
};

export type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

export type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

export function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

/** Logical qualification is independent of the thread that resolves the physical store. */
export function resolveSqliteSessionKey(sessionKey: string, agentId: string): string {
  const normalizedSessionKey = normalizeStoreSessionKey(sessionKey);
  return !normalizedSessionKey ||
    normalizedSessionKey === "global" ||
    normalizedSessionKey === "unknown" ||
    parseAgentSessionKey(normalizedSessionKey)
    ? normalizedSessionKey
    : toAgentStoreSessionKey({ agentId, requestKey: normalizedSessionKey });
}

type ResolveSqliteAgentIdParams = {
  scopedAgentId?: string;
  sessionKey?: string;
  storeAgentId?: string;
  storeShared?: boolean;
};

export function resolveSqliteAgentId(
  params: ResolveSqliteAgentIdParams & { storeAgentId: string },
): string;
export function resolveSqliteAgentId(params: ResolveSqliteAgentIdParams): string | undefined;
export function resolveSqliteAgentId(params: ResolveSqliteAgentIdParams): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (
    scopedAgentId &&
    params.storeAgentId &&
    scopedAgentId !== params.storeAgentId &&
    !params.storeShared
  ) {
    throw new Error(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  const parsedAgentId = params.sessionKey
    ? parseAgentSessionKey(params.sessionKey)?.agentId
    : undefined;
  return scopedAgentId ?? params.storeAgentId ?? parsedAgentId;
}

export function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "databaseAgentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions & { agentId: string } {
  return {
    agentId: scope.databaseAgentId ?? scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}
