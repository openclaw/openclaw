import { isDeepStrictEqual } from "node:util";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
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

type SessionEntrySourceMetadata = NonNullable<
  NonNullable<IncognitoSessionFacts["sharing"]>["entry"]
> &
  NonNullable<IncognitoSessionFacts["media"]> &
  NonNullable<IncognitoSessionFacts["modelSelection"]>;

const metadataFields: ReadonlySet<string> = new Set([
  "sessionId",
  "previousSessionId",
  "updatedAt",
  "createdAt",
  "initializationPending",
  "providerReview",
  "mainRestartRecovery",
  "modelSelectionLocked",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "lifecycleRevision",
  "lifecycleRunId",
  "activeWriterRunId",
  "subagentRecovery",
  "archivedAt",
  "category",
  "repositoryWorkspaceId",
  "visibility",
  "incognito",
  "createdActor",
  "owner",
  "sandbox",
  "spawnedBy",
  "spawnDepth",
  "parentSessionKey",
  "sessionStartedAt",
  "permissionMode",
  "toolOverrides",
  "execNode",
  "sessionRoot",
  "spawnedCwd",
  "spawnedWorkspaceDir",
  "worktree",
  "worktreeId",
  "projectId",
  "pluginOwnerId",
  "modelOverride",
  "modelOverrideSource",
  "providerOverride",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "agentRuntimeOverride",
  "agentHarnessId",
  "authProfileOverride",
  "sandboxMode",
  "nativeRuntimeConsent",
] satisfies (keyof SessionEntrySourceMetadata)[]);

function isMetadataField(
  field: keyof SessionEntry,
): field is keyof SessionEntrySourceMetadata & keyof SessionEntry {
  return metadataFields.has(field);
}

/** Capture the selected actor once; current effect predicates read only its acknowledged metadata. */
export function captureSessionEntryMetadataRead(scope: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    return {
      assertCurrent() {
        memory.authority.assertCurrent();
        memory.actor.assertReadable();
      },
      // Memory predicates are checked by the host authority, never a database worker.
      source: undefined,
      readCurrent(): SessionEntrySourceMetadata | undefined {
        return memory.actor.snapshot(memory.authority)?.entry;
      },
    };
  }
  const binding = captureIncognitoSessionSource(scope);
  if (!binding) {
    return undefined;
  }
  const assertCurrent = () => {
    binding.admissionSignal?.throwIfAborted();
    if ("kind" in binding) {
      binding.assertCurrent();
    } else {
      binding.actor.assertReadable();
    }
  };
  return {
    assertCurrent,
    source:
      "kind" in binding
        ? undefined
        : {
            agentId: binding.actor.agentId,
            path: binding.actor.path,
            databaseIdentity: binding.actor.identity.incarnation,
          },
    readCurrent(): SessionEntrySourceMetadata | undefined {
      assertCurrent();
      if ("kind" in binding) {
        return undefined;
      }
      const { sessions } = binding.actor;
      const sharing = sessions.readSharing(scope.sessionKey)?.entry;
      if (!sharing) {
        return undefined;
      }
      return {
        ...sharing,
        subagentRecovery: sharing.subagentRecovery,
        ...sessions.readMedia(scope.sessionKey),
        ...sessions.readModelSelection(scope.sessionKey),
      };
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
  const incognito = captureSessionEntryMetadataRead(params.scope);
  if (incognito) {
    if (params.prepareConversations) {
      throw new Error("Incognito conversation predicates require their actor preparation owner");
    }
    const fields = params.fields.filter(isMetadataField);
    if (fields.length !== params.fields.length) {
      throw new Error("Incognito source predicates require published session metadata");
    }
    const expected: Partial<SessionEntry> | undefined = params.expected
      ? structuredClone(
          Object.fromEntries(fields.map((field) => [field, params.expected?.[field]])),
        )
      : undefined;
    const assertScopeCurrent = () => {
      incognito.assertCurrent();
      params.assertHostCurrent?.();
    };
    const assertCurrent = () => {
      assertScopeCurrent();
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
          checks: incognito.source
            ? [
                {
                  predicate: {
                    source: incognito.source,
                    sessionKey: params.scope.sessionKey,
                    fields,
                    expected,
                  },
                  refuse: params.refuse,
                },
              ]
            : [],
        };
      },
    });
  }
  if (isIncognitoSessionKey(params.scope.sessionKey)) {
    return Object.assign(() => params.assertCurrent(), {
      nativeSource: true,
      async prepareSessionSource() {
        return { nativeSource: true, checks: [], assertCurrent: params.assertCurrent };
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
