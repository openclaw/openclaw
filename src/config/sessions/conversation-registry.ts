import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ConversationKind } from "./conversation-identity.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

export type ConversationRecord = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  target: string;
  parentConversationRef?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  sessionId: string;
  sessionKey: string;
  role: "participant" | "primary" | "related";
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationRegistryScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

function normalizeConversationRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONVERSATION_REF_PATTERN.test(normalized)) {
    throw new Error(`Invalid conversationRef: ${value}`);
  }
  return normalized;
}

function mapConversationRow(row: {
  account_id: string;
  channel: string;
  conversation_id: string;
  first_seen_at: number;
  kind: string;
  label: string | null;
  last_seen_at: number;
  delivery_target: string;
  native_channel_id: string | null;
  native_direct_user_id: string | null;
  parent_conversation_id: string | null;
  peer_id: string;
  role: string;
  session_id: string;
  session_key: string;
  thread_id: string | null;
}): ConversationRecord | null {
  if (row.kind !== "direct" && row.kind !== "group" && row.kind !== "channel") {
    return null;
  }
  if (row.role !== "primary" && row.role !== "participant" && row.role !== "related") {
    return null;
  }
  return {
    conversationRef: row.conversation_id,
    channel: row.channel,
    accountId: row.account_id,
    kind: row.kind,
    target: row.delivery_target,
    ...(row.parent_conversation_id ? { parentConversationRef: row.parent_conversation_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.native_channel_id ? { nativeChannelId: row.native_channel_id } : {}),
    ...(row.native_direct_user_id ? { nativeDirectUserId: row.native_direct_user_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    sessionId: row.session_id,
    sessionKey: row.session_key,
    role: row.role,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function selectConversationRows(
  scope: ConversationRegistryScope,
  options: { channel?: string; conversationRef?: string; limit?: number } = {},
): ConversationRecord[] {
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("conversations as c")
    .innerJoin("session_conversations as sc", "sc.conversation_id", "c.conversation_id")
    .innerJoin("sessions as s", "s.session_id", "sc.session_id")
    // Historical sessions retain address activity, while session_entries owns
    // the current session binding after reset/rebind.
    .innerJoin("session_entries as se", "se.session_key", "s.session_key")
    .select([
      "c.conversation_id",
      "c.channel",
      "c.account_id",
      "c.kind",
      "c.peer_id",
      "c.delivery_target",
      "c.parent_conversation_id",
      "c.thread_id",
      "c.native_channel_id",
      "c.native_direct_user_id",
      "c.label",
      "sc.role",
      "sc.first_seen_at",
      "sc.last_seen_at",
      "se.session_id",
      "se.session_key",
    ]);
  const channel = normalizeOptionalLowercaseString(options.channel);
  if (channel) {
    query = query.where("c.channel", "=", channel);
  }
  if (options.conversationRef) {
    query = query.where(
      "c.conversation_id",
      "=",
      normalizeConversationRef(options.conversationRef),
    );
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query.orderBy("sc.last_seen_at", "desc").orderBy("se.updated_at", "desc"),
  ).rows;
  const unique = new Map<string, ConversationRecord>();
  for (const row of rows) {
    const mapped = mapConversationRow(row);
    if (mapped && !unique.has(mapped.conversationRef)) {
      unique.set(mapped.conversationRef, mapped);
    }
  }
  const values = [...unique.values()];
  return options.limit === undefined ? values : values.slice(0, options.limit);
}

/** Lists stable external addresses for one agent, newest activity first. */
export function listConversations(
  scope: ConversationRegistryScope,
  options: { channel?: string; limit?: number } = {},
): ConversationRecord[] {
  return selectConversationRows(scope, options);
}

/** Resolves an opaque address to one exact channel target and backing context session. */
export function resolveConversation(
  scope: ConversationRegistryScope,
  conversationRef: string,
): ConversationRecord | undefined {
  return selectConversationRows(scope, {
    conversationRef: normalizeConversationRef(conversationRef),
    limit: 1,
  })[0];
}
