import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { withConversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import { selectConversationRowsFromDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type { ConversationRecord } from "./conversation-registry.types.js";

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

export async function prepareConversationRegistryScope(params: {
  agentId: string;
  config: OpenClawConfig;
}): Promise<PreparedConversationRegistryScope> {
  const input = {
    agentId: params.agentId,
    storePath: resolveSessionStorePathCore(params.config.session?.store, {
      agentId: params.agentId,
    }),
  };
  if (isIncognitoOpenClawAgentSqlitePath(input.storePath, input)) {
    return pinConversationDatabaseScope(input).scope;
  }
  return withConversationRead(input, async ({ database, logicalAgentId }) => ({
    agentId: logicalAgentId,
    databaseAgentId: database.agentId,
    storePath: database.path,
    env: database.env,
  }));
}

function withConversationRead<T>(
  input: ConversationRegistryScope,
  read: Parameters<typeof withSessionStoreReaderInWorker<T>>[1],
): Promise<T> {
  const env = captureSessionTranscriptStorageEnvironment(input.env ?? process.env);
  const storePath = path.resolve(
    input.storePath ?? resolveSessionStorePathCore(undefined, { agentId: input.agentId, env }),
  );
  const context = captureOpenClawStateReadWorkerContext({ env });
  const source = createOpenClawAgentDatabasePathMatcher();
  for (const candidate of captureSessionStoreReadCandidates(storePath)) {
    source(candidate.path, candidate.path);
  }
  return withSessionStoreReaderInWorker(
    { agentId: input.agentId, storePath, env },
    async (owner) => {
      if (input.databaseAgentId && owner.database.agentId !== input.databaseAgentId) {
        throw new Error("Conversation database owner changed. Retry the request.");
      }
      const result = await read(owner);
      owner.assertCurrent();
      return result;
    },
    {
      dataOnly: true,
      logical: {
        assertCurrent() {
          context.maintenanceScope?.assertAdmission();
          context.admission.assertCurrent();
          if (!source.isCurrent()) {
            throw new Error(
              "Session store changed while reading conversations. Retry the request.",
            );
          }
        },
      },
    },
  );
}

function selectConversationRowsInWorker(
  scope: ConversationRegistryScope,
  query: ConversationReadQuery,
): Promise<ConversationRecord[]> {
  const capturedQuery = structuredClone(query);
  if (scope.storePath && isIncognitoOpenClawAgentSqlitePath(scope.storePath, scope)) {
    // Process-held databases retain their native owner until the incognito cutover.
    return Promise.resolve(selectConversationRows(scope, capturedQuery));
  }
  return withConversationRead(scope, ({ reader, database }) =>
    reader.readConversations({ query: capturedQuery, env: database.env }),
  );
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

/** Catalogs routable addresses in the existing agent writer without creating sessions. */
export async function registerConversationAddresses(
  scope: ConversationRegistryScope,
  identities: readonly ConversationIdentity[],
  discoveredAt = Date.now(),
  selectEligible: (identities: readonly ConversationIdentity[]) => readonly boolean[] = (values) =>
    values.map(() => true),
  query?: ConversationReadQuery,
): Promise<ConversationRecord[] | undefined> {
  if (identities.length === 0) {
    return undefined;
  }
  const { options } = pinConversationDatabaseScope(scope);
  const input = {
    identities: structuredClone(identities),
    discoveredAt,
    query: query && structuredClone(query),
  };
  const selectCurrent = () => {
    const selected = selectEligible(input.identities);
    if (selected.length !== input.identities.length) {
      throw new Error("Conversation route owner returned an incomplete eligibility selection");
    }
    return selected;
  };
  const assertCurrent = () => {
    if (!selectCurrent().every(Boolean)) {
      throw new Error("Conversation route ownership changed during discovery");
    }
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {},
    createAdmission(binding) {
      return withConversationPublication(
        () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            if (request.stage === "transaction" || request.stage === "commit") {
              assertCurrent();
            }
            if (!grant()) {
              throw new Error("Conversation registration authority expired");
            }
          }, binding.attachment),
        }),
        () => binding.assertCurrent(),
        () => execution.captureGenerationClaim(),
        () => [
          ...new Set(
            input.identities.map((identity) =>
              JSON.stringify(["catalogue", identity.conversationRef]),
            ),
          ),
        ],
      );
    },
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  try {
    return await runOpenClawAgentWorkerWrite(options, async () => {
      const eligible = selectCurrent();
      input.identities = input.identities.filter((_, index) => eligible[index]);
      if (input.identities.length === 0) {
        return undefined;
      }
      // Reuse the acknowledged native generation; the write still refreshes under BEGIN.
      if (!execution.capturePreparedGenerationClaim()) {
        await execution.prepare(source);
      }
      return await execution.runExisting(source, (worker) =>
        worker.execute({ type: "conversation.register", input }),
      );
    });
  } finally {
    await execution.release();
  }
}

/** Initiate under the writer grant; settle network work after releasing its transaction and FIFO. */
export async function withConversationAuthority<T>(
  scope: ConversationRegistryScope,
  query: AgentDatabaseOperations["conversation.authority"]["input"],
  select: (
    facts: AgentDatabaseOperations["conversation.authority"]["output"],
  ) => () => T | Promise<T>,
): Promise<T> {
  const { options } = pinConversationDatabaseScope(scope);
  const input = structuredClone(query);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let consumed: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
  try {
    try {
      await runOpenClawAgentWorkerWrite(options, async () => {
        const settled = await execution.runExisting(
          {
            assertCurrent() {},
            createAdmission(binding) {
              return () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  let consume: (() => void) | undefined;
                  if (request.stage === "commit") {
                    const publication = isRecord(request.facts) && request.facts.publication;
                    if (
                      consumed ||
                      !isRecord(publication) ||
                      publication.kind !== "conversation-authority" ||
                      !isRecord(publication.facts)
                    ) {
                      throw new Error("Conversation authority omitted its transaction facts");
                    }
                    const facts =
                      // SAFETY: The private command supplies these facts under its validated identity.
                      publication.facts as AgentDatabaseOperations["conversation.authority"]["output"];
                    const initiate = select(facts);
                    consume = () => {
                      consumed = new Promise<T>((resolve) => {
                        resolve(initiate());
                      }).then(
                        (value) => ({ ok: true as const, value }),
                        (error: unknown) => ({ ok: false as const, error }),
                      );
                    };
                  }
                  if (!grant(consume)) {
                    throw new Error("Conversation read authority expired");
                  }
                }, binding.attachment),
              });
            },
          },
          (worker) => worker.execute({ type: "conversation.authority", input }),
        );
        if (!consumed && settled !== undefined) {
          throw new Error("Conversation authority omitted its transaction grant");
        }
      });
    } finally {
      await execution.release();
    }
  } catch (cause) {
    if (!consumed) {
      throw cause;
    }
    await consumed;
    const error = new SqliteWorkerError(
      "Conversation authority settlement failed after dispatch initiation",
      "outcome-unknown",
    );
    error.cause = cause;
    throw error;
  }
  if (!consumed) {
    return await select({ operation: undefined, conversation: undefined })();
  }
  const outcome = await consumed;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Lists stable external addresses for one agent, newest activity first. */
export function listConversations(
  scope: ConversationRegistryScope,
  options: { channel?: string; limit?: number } = {},
): Promise<ConversationRecord[]> {
  return selectConversationRowsInWorker(scope, options);
}

export async function readConversation(
  scope: ConversationRegistryScope,
  conversationRef: string,
): Promise<ConversationRecord | undefined> {
  return (await selectConversationRowsInWorker(scope, { conversationRef, limit: 1 }))[0];
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
export async function resolveCurrentSessionPrimaryConversation(
  scope: ConversationRegistryScope & { sessionId: string; sessionKey: string },
): Promise<ConversationRecord | undefined> {
  const [conversation] = await selectConversationRowsInWorker(scope, {
    primarySession: { sessionId: scope.sessionId, sessionKey: scope.sessionKey },
  });
  return conversation?.sessionId === scope.sessionId && conversation.sessionKey === scope.sessionKey
    ? conversation
    : undefined;
}
