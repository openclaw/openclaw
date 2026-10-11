import { isDeepStrictEqual } from "node:util";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type PreparedSessionSourceAssertion,
  type SessionSourceConversationPredicate,
} from "./session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Capture the owner once; effect predicates read its current acknowledged entry. */
export function captureSessionEntryMetadataRead(
  scope: {
    agentId?: string;
    sessionKey: string;
    storePath?: string;
    env?: NodeJS.ProcessEnv;
  },
  assertCallerCurrent: () => void,
) {
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent: assertCallerCurrent,
    authorize: assertCallerCurrent,
  });
  if (!memory) {
    return undefined;
  }
  const assertCurrent = () => {
    memory.authority.assertCurrent();
    memory.owner?.assertCurrent();
    memory.binding?.actor.assertReadable();
  };
  return {
    assertCurrent,
    readCurrent(): SessionEntry | undefined {
      assertCurrent();
      return readCapturedSessionActorEntry(memory, scope.sessionKey);
    },
  };
}

/** Retain a selected entry's authority while its predicates move into the destination writer. */
export function captureSessionEntrySourceAssertion(params: {
  scope: { agentId: string; sessionKey: string; storePath: string; env?: NodeJS.ProcessEnv };
  readSource?: CapturedSessionEntryReadSource;
  expected: Partial<SessionEntry> | undefined;
  fields: readonly (keyof SessionEntry)[];
  assertCurrent: () => void;
  assertHostCurrent?: () => void;
  prepareConversations?: (
    read: (conversationRefs: readonly string[]) => Promise<ReadonlyMap<string, string | null>>,
  ) => Promise<{
    alternatives: readonly (readonly SessionSourceConversationPredicate[])[];
    assertCurrent: () => void;
    acceptMatches: (alternatives: readonly number[]) => number[];
  }>;
  refuse: () => never;
}): PreparedSessionSourceAssertion {
  const incognito = captureSessionEntryMetadataRead(params.scope, () =>
    params.assertHostCurrent?.(),
  );
  if (incognito) {
    if (params.prepareConversations) {
      throw new Error("Incognito conversation predicates require their actor preparation owner");
    }
    const fields = [...params.fields];
    const expected: Partial<SessionEntry> | undefined = params.expected
      ? structuredClone(
          Object.fromEntries(fields.map((field) => [field, params.expected?.[field]])),
        )
      : undefined;
    const assertScopeCurrent = () => incognito.assertCurrent();
    const assertCurrent = () => {
      const current = incognito.readCurrent();
      if (
        (current === undefined) !== (expected === undefined) ||
        fields.some((field) => !isDeepStrictEqual(current?.[field], expected?.[field]))
      ) {
        params.refuse();
      }
      params.assertCurrent();
    };
    return Object.assign(assertCurrent, {
      assertScopeCurrent,
      async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
        assertCurrent();
        return {
          assertCurrent,
          checks: [],
        };
      },
    });
  }
  const locator = captureSessionStoreReadCandidate(
    resolveUnsuffixedSqliteTargetFromSessionStorePath(params.scope.storePath).path,
  );
  const candidates = params.readSource
    ? [captureSessionStoreReadCandidate(params.readSource.path)]
    : captureSessionStoreReadCandidates(params.scope.storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const fields = [...params.fields];
  const expected: Partial<SessionEntry> | undefined = params.expected
    ? structuredClone(Object.fromEntries(fields.map((field) => [field, params.expected?.[field]])))
    : undefined;
  const env = captureSessionTranscriptStorageEnvironment(params.scope.env ?? process.env);
  const scope = { ...params.scope, env };
  return Object.assign(() => params.assertCurrent(), {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      params.assertHostCurrent?.();
      if (![locator, ...candidates].every(isSessionStoreReadCandidateCurrent)) {
        params.refuse();
      }
      const target = params.readSource ?? toDatabaseOptions(await prepareSqliteScope(scope));
      if (!target.path) {
        params.refuse();
      }
      let physicalPath: string;
      try {
        physicalPath = assertSessionStoreReadCandidate(target.path, candidates);
      } catch {
        params.refuse();
      }
      const identity = identities.get(physicalPath);
      if (!identity?.key.startsWith("file:")) {
        params.refuse();
      }
      const source = params.readSource ?? {
        agentId: target.agentId,
        path: physicalPath,
        databaseIdentity: identity.key.slice("file:".length),
        databaseBirthtime: identity.birthtime,
      };
      const assertCaptured = () => {
        params.assertHostCurrent?.();
        if (
          typeof source.databaseIdentity !== "string" ||
          source.path !== physicalPath ||
          ![locator, ...candidates].every(isSessionStoreReadCandidateCurrent)
        ) {
          params.refuse();
        }
        assertExistingDatabaseIdentity(
          source.path,
          `file:${source.databaseIdentity}`,
          source.databaseBirthtime,
        );
      };
      assertCaptured();
      const database = { agentId: source.agentId, path: source.path, env };
      const native = params.prepareConversations
        ? undefined
        : getOpenClawAgentDatabaseIfOpen(database);
      const revision = native && readSqliteNativeMutationRevision(native.db);
      const retained = retainSessionHistoryWorkerDatabase(database);
      let active = true;
      let conversations:
        | Awaited<ReturnType<NonNullable<typeof params.prepareConversations>>>
        | undefined;
      const assertCurrent = () => {
        assertCaptured();
        retained.owner.assertCurrent();
        conversations?.assertCurrent();
        if (
          !active ||
          (!params.prepareConversations &&
            (getOpenClawAgentDatabaseIfOpen(database) !== native ||
              (native &&
                (native.db.isTransaction ||
                  revision === undefined ||
                  readSqliteNativeMutationRevision(native.db) !== revision))))
        ) {
          params.refuse();
        }
      };
      try {
        const result = await retained.owner.readExactEntries({
          sessionKeys: [scope.sessionKey],
          projection: "full",
          includeAuthorization: true,
          env,
        });
        assertCurrent();
        const entry = result.entries.find((row) => row.sessionKey === scope.sessionKey)?.entry;
        if (
          result.databaseIdentity?.identity !== source.databaseIdentity ||
          result.databaseIdentity?.birthtime !== source.databaseBirthtime ||
          (entry === undefined) !== (expected === undefined) ||
          fields.some((field) => !isDeepStrictEqual(entry?.[field], expected?.[field]))
        ) {
          params.refuse();
        }
        // Complete alternative predicates are revalidated by the writer; unrelated native
        // writes cannot revoke a still-matching branch through a whole-store revision.
        conversations = await params.prepareConversations?.(async (conversationRefs) => {
          if (conversationRefs.length === 0) {
            return new Map();
          }
          const rows = await retained.owner.readConversations({
            query: { conversationRefs, currentBindingOnly: true },
            env,
          });
          assertCurrent();
          return new Map(
            rows.map((row) => [
              row.conversationRef,
              row.sessionKey && row.sessionId ? row.sessionKey : null,
            ]),
          );
        });
        assertCurrent();
        return {
          assertCurrent,
          checks: [
            {
              predicate: {
                source,
                sessionKey: scope.sessionKey,
                fields,
                expected,
                ...(conversations ? { conversationAlternatives: conversations.alternatives } : {}),
              },
              refuse: params.refuse,
              acceptConversationMatches: conversations?.acceptMatches,
            },
          ],
          release: () => {
            active = false;
            retained.release();
          },
        };
      } catch (error) {
        active = false;
        await releaseSessionSourceAuthorities([retained], [error]);
        throw error;
      }
    },
  });
}
