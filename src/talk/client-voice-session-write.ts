import { randomUUID } from "node:crypto";
import { applySessionEntryTargetOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  acceptSessionSourceValidation,
  assertPreparedSessionSourceCurrent,
  prepareSessionSourceAuthority,
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourceWriteGrant,
  type SessionSourceTransactionGrant,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
  type SessionStoreReadCustody,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreCandidatesInWorker } from "../config/sessions/session-transcript-worker-resources.js";
import { collectSessionEntryLookupKeys } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import {
  assertDatabasePathIdentity,
  resolveDatabasePathKeyAsync,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-admission-contract.js";
import {
  runOpenClawAgentPreparedWriteAdmission,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { ensureMemoryVoiceEntry, prepareMemoryVoiceSource } from "./client-voice-memory-entry.js";
import {
  withClientVoiceSessionSettlement,
  withClientVoiceSessionResources,
} from "./client-voice-session-lifecycle.js";
import {
  captureClientVoiceEntrySource,
  captureClientVoiceSessionSourceOptions,
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
  prepareClientVoiceSessionSourceChecks,
  selectPreparedClientVoiceSource,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  deadlineAt?: number;
  requester?: SessionSourceAssertion;
  source?: SessionSourceAssertion;
  prepareWorkerGrant?: (
    target: Omit<SessionSourceTransactionGrant, "assertCurrent">,
  ) => Promise<SessionSourceWriteGrant>;
  assertCurrent?: () => void;
  followRegistration?: AgentDatabaseRequestExecutionSource["onRegistryChange"];
  onCommitted?: (entry: InternalSessionEntry) => void;
  onCommittedSource?: (source: CapturedSessionEntryReadSource, entry: InternalSessionEntry) => void;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
}): Promise<string> {
  const assertLifetimeCurrent = () => {
    params.assertCurrent?.();
    if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      throw new Error("Realtime browser session expired during startup; try again");
    }
  };
  const reduction = () => {
    const fallbackEntry = mergeSessionEntry(undefined, {});
    return {
      operation: {
        kind: "ensure-identity" as const,
        sessionId: fallbackEntry.sessionId,
        creation: buildSessionCreationStamp({
          via: "talk",
          actor: params.creation?.actor ?? { type: "human", source: "unknown" },
          sandbox: params.creation?.sandbox,
        }),
      },
      fallbackEntry,
    };
  };
  const publication = {
    onCommitted: params.onCommitted,
    onCommittedSource: params.onCommittedSource,
  };
  const complete = (created: InternalSessionEntry | null) => {
    if (!created?.sessionId) {
      throw new Error(`agent session could not be initialized (${params.sessionKey})`);
    }
    return created.sessionId;
  };
  const assertCurrent = composeSessionSourceAssertion([
    assertLifetimeCurrent,
    params.requester,
    params.source,
  ]);
  const memory = await acquireSessionActorStorage(params, {
    create: true,
    lifetime: { assertCurrent, assertReadable: assertCurrent },
    authority: { assertCurrent, authorize() {} },
  });
  if (memory) {
    try {
      return complete(
        await ensureMemoryVoiceEntry({
          binding: memory,
          ...reduction(),
          ...publication,
          assertCurrent,
        }),
      );
    } finally {
      await memory.actor.release();
    }
  }
  const original = captureClientVoiceSessionSourceOptions(params.agentId);
  assertLifetimeCurrent();
  const resources: Array<Pick<PreparedSessionSourceAuthority, "release">> = [];
  return withClientVoiceSessionResources(resources, async () => {
    return await runOpenClawAgentPreparedWriteAdmission(
      async () => {
        const selected = await captureClientVoiceEntrySource(
          params,
          assertLifetimeCurrent,
          original,
        );
        resources.push(selected.execution);
        return selected;
      },
      async (selected) => {
        const { execution, agentId } = selected;
        const requester = await prepareSessionSourceAuthority(params.requester);
        resources.push(requester);
        const borrowedRequester = Object.assign(() => params.requester?.(), {
          prepareSessionSource: async () => ({ ...requester, release: undefined }),
        });
        const source = composeSessionSourceAssertion([
          borrowedRequester,
          params.source,
          Object.assign(selected.assertCurrent, {
            prepareSessionSource: async () => ({
              checks: [],
              readCustody: selected.readCustody,
              assertCurrent: selected.assertCurrent,
            }),
          }),
        ]);
        const assertPreparationCurrent = () => {
          execution.assertCurrent();
          if (requester.nativeSource || requester.opaqueCommitGuard) {
            selected.assertLegacyCurrent();
          } else {
            selected.assertCurrent();
          }
          assertPreparedSessionSourceCurrent(requester);
        };
        if (selected.creating || !requester.opaqueCommitGuard) {
          // Preparation publishes the physical source through the existing database worker.
          await execution.prepare({
            readCustody: selected.readCustody,
            assertCurrent: () => {
              assertPreparationCurrent();
              if (requester.opaqueCommitGuard) {
                source();
              }
            },
            onRegistryChange: params.followRegistration,
            createAdmission: (binding) => () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                binding.authorize(request);
                assertPreparationCurrent();
                if (requester.opaqueCommitGuard) {
                  source();
                }
                if (!grant()) {
                  throw new Error("Talk entry preparation authority expired");
                }
              }, binding.attachment),
            }),
          });
        }
        const apply = async () => {
          assertPreparationCurrent();
          const identity = execution.fileIdentity;
          if (!identity) {
            throw new Error("Talk entry preparation omitted its physical source");
          }
          const canonicalKey = resolveSqliteSessionKey(params.sessionKey, agentId);
          const readSource: CapturedSessionEntryReadSource = {
            agentId: execution.agentId,
            path: identity.nativeLocation,
            databaseIdentity: identity.physicalIdentity,
            databaseBirthtime: identity.birthtime,
          };
          const grant =
            !requester.nativeSource && !requester.opaqueCommitGuard && requester.checks.length === 0
              ? await params.prepareWorkerGrant?.({
                  source: readSource,
                  agentId,
                  sessionKey: canonicalKey,
                })
              : undefined;
          if (grant) {
            resources.push(grant);
          }
          assertPreparationCurrent();
          grant?.assertLifetimeCurrent();
          const { operation, fallbackEntry } = reduction();
          return complete(
            await applySessionEntryTargetOperation(
              {
                agentId,
                env: selected.options.env,
                storePath: selected.storePath,
                target: { canonicalKey, storeKeys: collectSessionEntryLookupKeys(canonicalKey) },
                readSource,
              },
              operation,
              {
                ...publication,
                fallbackEntry,
                retainedExecution: execution,
                workerGuard: {
                  source: grant?.transaction ? borrowedRequester : source,
                  ensureIdentitySource: grant?.transaction,
                  assertCurrent: () => {
                    assertPreparationCurrent();
                    grant?.assertLifetimeCurrent();
                  },
                },
              },
            ),
          );
        };
        if (!requester.opaqueCommitGuard) {
          return apply();
        }
        const { withOpenClawAgentDatabaseAsync } = await import("../state/openclaw-agent-db.js");
        return withOpenClawAgentDatabaseAsync(
          selected.options,
          async (database) => {
            await execution.adoptNativeDatabase(database);
            return apply();
          },
          () => {
            assertPreparationCurrent();
            source();
          },
        );
      },
      true,
    );
  });
}

export type ClientVoiceSessionMutationAuthority = {
  assertCurrent?: () => void;
  requester?: SessionSourceAssertion;
  source?: {
    assertCurrent: SessionSourceAssertion;
    storePath: string;
    prepareWorkerGrant?: () => Promise<SessionSourceWriteGrant>;
    retainWorkerGrant?: (grant: SessionSourceWriteGrant) => void;
  };
};

/** Prepare authority once, then mutate and publish under the existing physical-store FIFO. */
export async function mutateAuthorizedClientVoiceSession<T>(
  params: ClientVoiceSessionMutationAuthority & { agentId: string },
  writer: ClientVoiceSessionWriter,
  prepareMutation: () => Extract<VoiceSessionMutation, { kind: "create" | "consult" }>,
  publish: (record: ClientVoiceSessionRecord | undefined) => T,
): Promise<T> {
  const resources: Array<Pick<PreparedSessionSourceAuthority, "release">> = [];
  return withClientVoiceSessionResources(resources, async () => {
    const memorySource = params.source
      ? captureSessionActorStorageOwner(
          { storePath: params.source.storePath },
          { assertCurrent: params.source.assertCurrent, authorize() {} },
        )
      : undefined;
    const pendingCandidates =
      params.source && !memorySource
        ? prepareSessionStoreCandidatesInWorker({ storePath: params.source.storePath })
        : Promise.resolve({ candidates: [] });
    void pendingCandidates.catch(() => {});
    // Reserve accepted order before authority preparation yields, without a native write lock.
    return await runOpenClawAgentWriteAdmission(
      writer.options,
      async () => {
        await writer.prepare();
        const { candidates: sourceCandidates } = await pendingCandidates;
        const sourceIdentities = captureSessionStoreCandidateIdentities(sourceCandidates);
        const assertSourceLocatorsCurrent = () => {
          if (!sourceCandidates.every(isSessionStoreReadCandidateCurrent)) {
            throw new Error("Voice session source changed");
          }
        };
        let readCustody: readonly SessionStoreReadCustody[] | undefined;
        writer.assertCurrent();
        params.assertCurrent?.();
        const requester = await prepareSessionSourceAuthority(params.requester);
        resources.push(requester);
        params.assertCurrent?.();
        requester.assertCurrent();
        const mutation = prepareMutation();
        let assertSourceIdentityCurrent: (() => void) | undefined;
        let authority: PreparedSessionSourceAuthority | undefined;
        let workerGrant: SessionSourceWriteGrant | undefined;
        if (params.source && memorySource) {
          authority = await prepareMemoryVoiceSource(memorySource, params.source.assertCurrent);
          resources.push(authority);
        } else if (params.source) {
          if (
            params.source.prepareWorkerGrant &&
            !requester.nativeSource &&
            !requester.opaqueCommitGuard &&
            [...sourceIdentities.values()].every(
              (identity) =>
                !identity.key.startsWith("file:") ||
                (identity.key === writer.identity.key &&
                  identity.birthtime === writer.identity.birthtime),
            )
          ) {
            workerGrant = await params.source.prepareWorkerGrant();
            resources.push(workerGrant);
          }
          authority = workerGrant?.transaction
            ? {
                checks: [],
                assertCurrent: workerGrant.assertLifetimeCurrent,
                transaction: workerGrant.transaction,
              }
            : await prepareSessionSourceAuthority(params.source.assertCurrent);
          if (!workerGrant?.transaction) {
            resources.push(authority);
          }
          const preparedSource = selectPreparedClientVoiceSource(authority, sourceIdentities);
          const canonical = resolveUnsuffixedSqliteTargetFromSessionStorePath(
            params.source.storePath,
          );
          // Reuse the prepared physical owner; opaque SDK sources resolve their original selector.
          const sourceTarget =
            preparedSource ??
            (canonical.agentId
              ? { ...canonical, agentId: canonical.agentId ?? params.agentId }
              : await prepareSqliteTargetFromSessionStorePath(params.source.storePath, {
                  agentId: params.agentId,
                  env: writer.options.env,
                }));
          const sourcePath = await resolveDatabasePathKeyAsync(sourceTarget.path);
          const sourceIdentity = sourceIdentities.get(sourcePath);
          if (!sourceTarget.agentId || !sourceIdentity) {
            throw new Error("Voice session source changed its captured database owner");
          }
          const assertSourceCurrent = () => {
            assertSourceLocatorsCurrent();
            assertSessionStoreReadCandidate(sourceTarget.path, sourceCandidates);
            assertDatabasePathIdentity(sourcePath, sourceIdentity);
          };
          readCustody = [{ sourcePath: sourceTarget.path, candidates: sourceCandidates }];
          await prepareSessionStoreCandidatesInWorker({
            validate: {
              readCustody,
              candidates: [],
              sources: [{ path: sourcePath, identity: sourceIdentity }],
            },
          });
          writer.assertCurrent();
          params.assertCurrent?.();
          requester.assertCurrent();
          authority.assertCurrent();
          assertSourceIdentityCurrent = assertSourceCurrent;
          if (
            (sourceIdentity.key !== writer.identity.key ||
              sourceIdentity.birthtime !== writer.identity.birthtime) &&
            (requester.nativeSource ||
              requester.opaqueCommitGuard ||
              authority.nativeSource ||
              authority.opaqueCommitGuard ||
              authority.checks.length === 0)
          ) {
            const native = retainOpenClawAgentDatabaseReadOnly({
              ...writer.options,
              agentId: sourceTarget.agentId,
              path: sourcePath,
            });
            if (!native.found) {
              throw new Error("Voice session source is unavailable");
            }
            resources.push(native.claim);
            assertSourceIdentityCurrent = () => {
              assertSourceCurrent();
              native.claim.assertCurrent();
            };
          }
        }
        const sources = await prepareClientVoiceSessionSourceChecks(
          writer,
          authority ? [requester, authority] : [requester],
        );
        resources.push(sources);
        let committed: T;
        if (
          sources.nativeSource ||
          requester.nativeSource ||
          requester.opaqueCommitGuard ||
          authority?.nativeSource ||
          authority?.opaqueCommitGuard
        ) {
          // Released synchronous SDK writers require cross-store event-loop atomicity until the next major.
          const [
            { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseRuntimeFromExecution },
            { runOpenClawAgentWriteWithYieldingAdmission },
            { hasSqliteSessionOwnerColumns },
            { readSessionSourceValidation },
            { readSessionPendingInputAuthorityFactsInTransaction },
            kernel,
          ] = await Promise.all([
            import("../state/openclaw-agent-db.js"),
            import("../state/openclaw-agent-db-transaction.js"),
            import("../config/sessions/session-accessor.sqlite-owner-projection.js"),
            import("../config/sessions/session-source-predicate.worker.js"),
            import("../config/sessions/session-pending-input-authority.kernel.js"),
            import("./client-voice-session-write.kernel.js"),
          ]);
          const opaqueGuard = requester.opaqueCommitGuard || authority?.opaqueCommitGuard;
          const predicates = sources.checks.map((check) => check.predicate);
          const assertPreparationCurrent = () => {
            assertSourceLocatorsCurrent();
            assertSourceIdentityCurrent?.();
            writer.assertLegacyCurrent();
            params.assertCurrent?.();
            assertPreparedSessionSourceCurrent(requester);
          };
          const assertNativeCurrent = (transaction?: OpenClawAgentDatabase) => {
            // An SDK guard need not check a source alias, even when it shares the writer's file.
            assertPreparationCurrent();
            if (transaction) {
              acceptSessionSourceValidation(
                sources,
                readSessionSourceValidation(transaction, predicates),
              );
            }
            sources.assertCurrent();
            if (transaction) {
              if (authority?.transaction) {
                authority.transaction.assertCurrent(
                  readSessionPendingInputAuthorityFactsInTransaction(
                    transaction,
                    authority.transaction.sessionKey,
                    authority.transaction.agentId,
                  ),
                );
              }
            }
            assertSourceIdentityCurrent?.();
          };
          committed = await runOpenClawAgentWriteAdmission(
            writer.options,
            async () => {
              assertDatabasePathIdentity(writer.options.path, writer.identity);
              const mutate = async (database: OpenClawAgentDatabase) => {
                assertNativeCurrent();
                await writer.adoptNativeDatabase(database);
                assertNativeCurrent();
                if (predicates.length > 0 || authority?.transaction) {
                  hasSqliteSessionOwnerColumns(database.db);
                }
                return runOpenClawAgentWriteWithYieldingAdmission(
                  (transaction) => {
                    assertNativeCurrent(transaction);
                    const committedRecord = kernel.mutateVoiceSessionInDatabase(
                      transaction,
                      mutation,
                    );
                    assertNativeCurrent(transaction);
                    return committedRecord;
                  },
                  writer.options,
                  { operationLabel: `voice.session.${mutation.kind}` },
                );
              };
              const record = opaqueGuard
                ? await withOpenClawAgentDatabaseAsync(writer.options, mutate, assertNativeCurrent)
                : await withOpenClawAgentDatabaseRuntimeFromExecution(
                    writer.options,
                    writer.admissionExecution,
                    mutate,
                    assertPreparationCurrent,
                  );
              return publish(record);
            },
            true,
          );
        } else {
          committed = await writer.mutate(mutation, publish, {
            readCustody,
            checks: sources.checks,
            transaction: authority?.transaction,
            assertCurrent: () => {
              params.assertCurrent?.();
              sources.assertCurrent();
            },
          });
        }
        if (workerGrant?.transaction && params.source?.retainWorkerGrant) {
          params.source.retainWorkerGrant(workerGrant);
          resources.splice(resources.indexOf(workerGrant), 1);
        }
        return committed;
      },
      true,
    );
  });
}

/** Create a call record or resume the same open call across transport restarts. */
export async function createOrResumeClientVoiceSession(
  input: ClientVoiceSessionMutationAuthority & {
    agentId: string;
    sessionKey: string;
    provider?: string;
    origin: "client" | "relay";
    transcriptCapable?: boolean;
    voiceSessionId?: string;
    physicalSource?: ClientVoiceSessionSource;
    now?: number;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<string> {
  const params = { ...input };
  return withClientVoiceSessionSettlement(
    async () => {
      const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
      const writer =
        retainedWriter ??
        captureClientVoiceSessionWriter({
          agentId: params.agentId,
          physicalSource: params.physicalSource,
        });
      return withClientVoiceSessionResources(retainedWriter ? [] : [writer], () =>
        mutateAuthorizedClientVoiceSession(
          params,
          writer,
          () => ({
            kind: "create",
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
            provider: params.provider?.trim() || undefined,
            origin: params.origin,
            transcriptCapable: params.transcriptCapable,
            now: params.now ?? Date.now(),
          }),
          () => voiceSessionId,
        ),
      );
    },
    undefined,
    retainedWriter?.settlementContext ?? params.physicalSource?.settlementContext,
  );
}
