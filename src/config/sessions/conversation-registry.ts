import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  selectConversationRowsFromDatabase,
  type ConversationRecord,
} from "./session-accessor.sqlite-conversation-read.js";
import { upsertConversationIdentity } from "./session-accessor.sqlite-conversation.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

export type { ConversationRecord } from "./session-accessor.sqlite-conversation-read.js";

export type ConversationRegistryScope = {
  agentId: string;
  /** Physical schema owner captured with an exact store locator. */
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

export type PreparedConversationRegistryScope = {
  agentId: string;
  databaseAgentId: string;
  env: NodeJS.ProcessEnv;
  storePath: string;
};

export function resolveConversationRegistryScope(params: {
  agentId: string;
  config: OpenClawConfig;
}): PreparedConversationRegistryScope {
  const scope = {
    agentId: params.agentId,
    storePath: resolveSessionStorePathCore(params.config.session?.store, {
      agentId: params.agentId,
    }),
  };
  return pinConversationDatabaseScope(scope).scope;
}

export function pinConversationDatabaseScope(input: ConversationRegistryScope) {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options =
    input.databaseAgentId && input.storePath
      ? { agentId: input.databaseAgentId, path: input.storePath, env }
      : toDatabaseOptions(resolveSqliteReadScope({ ...input, env }));
  const storePath = resolveOpenClawAgentSqlitePath(options);
  return {
    options: { ...options, path: storePath },
    scope: { ...input, databaseAgentId: options.agentId, storePath, env },
  };
}

/** Keep the logical agent and physical store fixed while its synchronous write waits. */
export function runConversationDatabaseWrite<T>(
  input: ConversationRegistryScope,
  operation: (scope: PreparedConversationRegistryScope) => T,
): Promise<T> {
  const { options, scope } = pinConversationDatabaseScope(input);
  return withOpenClawAgentDatabaseWrite(options, () => operation(scope));
}

function selectConversationRows(
  scope: ConversationRegistryScope,
  options: Parameters<typeof selectConversationRowsFromDatabase>[1] = {},
): ConversationRecord[] {
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const databaseOptions = toDatabaseOptions(resolved);
  const readRows = (database: OpenClawAgentReadOnlyDatabase): ConversationRecord[] =>
    selectConversationRowsFromDatabase(database, options);
  const held = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  // Commit guards must see the owning transaction's rows without opening a
  // separate connection that would hide uncommitted conversation changes.
  if (held?.db.isTransaction) {
    return readRows(held);
  }
  const read = withOpenClawAgentDatabaseReadOnly(readRows, databaseOptions);
  return read.found ? read.value : [];
}

/** Catalogs routable addresses without creating model-context sessions. */
export function registerConversationAddresses(
  scope: ConversationRegistryScope,
  identities: readonly ConversationIdentity[],
  discoveredAt = Date.now(),
): void {
  if (identities.length === 0) {
    return;
  }
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  for (const identity of identities) {
    upsertConversationIdentity(database, identity, discoveredAt);
  }
}

/** Lists stable external addresses for one agent, newest activity first. */
export function listConversations(
  scope: ConversationRegistryScope,
  options: { channel?: string; limit?: number } = {},
): ConversationRecord[] {
  return selectConversationRows(scope, options);
}

/** Resolves an opaque address to one exact channel target and its context binding, when present. */
export function resolveConversation(
  scope: ConversationRegistryScope,
  conversationRef: string,
): ConversationRecord | undefined {
  return selectConversationRows(scope, {
    conversationRef,
    limit: 1,
  })[0];
}

/** Reads only an authoritative association on an address's current session window. */
export function resolveCurrentConversationSession(
  scope: ConversationRegistryScope,
  conversationRef: string,
  currentSession?: { sessionKey: string; sessionId: string },
): { sessionKey: string; sessionId: string } | undefined {
  const [conversation] = selectConversationRows(scope, {
    conversationRef,
    currentBindingOnly: true,
    currentSession,
    limit: 1,
  });
  return conversation?.sessionKey && conversation.sessionId
    ? { sessionKey: conversation.sessionKey, sessionId: conversation.sessionId }
    : undefined;
}

/** Reads only the primary address bound to this exact current session window. */
export function resolveCurrentSessionPrimaryConversation(
  scope: ConversationRegistryScope & { sessionId: string; sessionKey: string },
): ConversationRecord | undefined {
  const [conversation] = selectConversationRows(scope, { primarySession: scope });
  return conversation?.sessionId === scope.sessionId && conversation.sessionKey === scope.sessionKey
    ? conversation
    : undefined;
}
