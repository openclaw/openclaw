import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  applySessionEntryOperation,
  applySessionEntryTargetOperation,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  assertPreparedSessionSourceCurrent,
  prepareSessionSourceAuthority,
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourceValidation,
  type SessionSourceWriteGrant,
  type SessionSourceTransactionGrant,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { collectSessionEntryLookupKeys } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import { assertDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type {
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { ensureMemoryVoiceEntry, prepareMemoryVoiceSource } from "./client-voice-memory-entry.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  withClientVoiceSessionSettlement,
  withClientVoiceSessionResources,
} from "./client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  captureClientVoiceEntrySource,
  createClientVoiceSessionSource,
  prepareClientVoiceSessionSourceChecks,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Voice metadata keeps its durable agent owner, including for incognito transcripts. */
export function captureClientVoiceSessionWriter(params: {
  agentId: string;
  assertCurrent?: () => void;
  physicalSource?: ClientVoiceSessionSource;
}) {
  const captured = params.physicalSource ?? captureClientVoiceSessionSource(params.agentId);
  const options = captured.options;
  captured.assertCurrent();
  const existing = captured.identity.key.startsWith("file:");
  const execution = captureOpenClawAgentDatabaseExecution(
    options,
    existing
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: captured.identity.key.slice("file:".length),
            birthtime: captured.identity.birthtime,
            nativeLocation: captured.identity.canonicalPath,
          },
        }
      : { expectedCreationIdentity: captured.identity },
  );
  const assertCurrent = () => {
    assertClientVoiceSessionSettlementCurrent(captured.settlementContext);
    execution.assertCurrent();
    if (existing) {
      captured.assertCurrent();
    }
    params.assertCurrent?.();
  };
  const createSource = (
    authority?: PreparedSessionSourceAuthority,
  ): AgentDatabaseRequestExecutionSource => ({
    assertCurrent: () => {
      assertCurrent();
      authority?.assertCurrent();
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (isRecord(facts) && facts.kind === "voice-session-authority") {
            if (!authority) {
              throw new Error("Voice session authority omitted its prepared assertion");
            }
            if (facts.sourceValidation) {
              acceptSessionSourceValidation(
                authority,
                // SAFETY: voice.session.mutate supplies validation from this transaction.
                facts.sourceValidation as SessionSourceValidation,
              );
            }
            if (facts.facts) {
              if (!authority.transaction) {
                throw new Error("Voice session transaction omitted its prepared assertion");
              }
              // SAFETY: voice.session.mutate supplies the pending-input facts from this transaction.
              authority.transaction.assertCurrent(facts.facts as SessionPendingInputAuthorityFacts);
            }
            authority.assertCurrent();
          }
          if (!grant()) {
            throw new Error("Voice session write authority expired");
          }
        }, binding.attachment),
      });
    },
  });
  function mutate(
    input: VoiceSessionMutation,
    publish?: undefined,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<ClientVoiceSessionRecord | undefined>;
  function mutate<T>(
    input: VoiceSessionMutation,
    publish: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T>;
  async function mutate<T>(
    input: VoiceSessionMutation,
    publish?: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T | ClientVoiceSessionRecord | undefined> {
    const mutation = structuredClone(input);
    const source = createSource(authority);
    return runOpenClawAgentWorkerWrite(options, async () => {
      if (mutation.kind === "create") {
        await execution.prepare(source);
      }
      const result = await execution.runExisting(source, async (worker) => {
        const committed = await worker.execute({
          type: "voice.session.mutate",
          input: {
            ...mutation,
            ...(authority?.transaction
              ? {
                  transactionSource: {
                    source: authority.transaction.source,
                    agentId: authority.transaction.agentId,
                    sessionKey: authority.transaction.sessionKey,
                  },
                }
              : {}),
            ...(authority?.checks.length
              ? { sources: authority.checks.map((check) => check.predicate) }
              : {}),
          },
        });
        // Install acknowledged facts before releasing the existing writer FIFO.
        return {
          value: publish ? publish(committed.record, committed.entry) : committed.record,
        };
      });
      if (!result) {
        throw new Error("Voice session database is missing");
      }
      return result.value;
    });
  }
  const readCommittedIdentity = () => {
    const committed = execution.fileIdentity;
    return (
      committed && {
        key: `file:${committed.physicalIdentity}`,
        birthtime: committed.birthtime,
        canonicalPath: committed.nativeLocation,
      }
    );
  };
  return {
    options,
    get identity() {
      return readCommittedIdentity() ?? captured.identity;
    },
    settlementContext: captured.settlementContext,
    get source(): ClientVoiceSessionSource {
      assertCurrent();
      const committed = readCommittedIdentity();
      if (committed) {
        return createClientVoiceSessionSource(options, committed);
      }
      if (existing) {
        return captured;
      }
      throw new Error("Voice session creation has not been acknowledged");
    },
    assertCurrent,
    get admissionExecution(): OpenClawAgentDatabaseAdmissionExecution {
      return execution;
    },
    adoptNativeDatabase: (database: OpenClawAgentDatabase) =>
      execution.adoptNativeDatabase(database),
    release: () => execution.release(),
    read(voiceSessionId: string) {
      return runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(createSource(), async (worker) => {
          const result = await worker.execute({
            type: "voice.session.read",
            input: { voiceSessionId },
          });
          assertCurrent();
          return result;
        }),
      );
    },
    mutate,
  };
}

export type ClientVoiceSessionWriter = ReturnType<typeof captureClientVoiceSessionWriter>;

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
  const memory = getSessionActorStorageBinding(params);
  if (memory || isIncognitoSessionKey(params.sessionKey)) {
    const prepared = reduction();
    const assertCurrent = composeSessionSourceAssertion([
      assertLifetimeCurrent,
      params.requester,
      params.source,
    ]);
    return complete(
      memory
        ? await ensureMemoryVoiceEntry({
            binding: memory,
            ...prepared,
            ...publication,
            assertCurrent,
          })
        : await applySessionEntryOperation(params, prepared.operation, {
            ...publication,
            fallbackEntry: prepared.fallbackEntry,
            workerGuard: { assertCurrent: assertLifetimeCurrent },
            assertCommitAllowed: assertCurrent,
          }),
    );
  }
  const resources: Array<Pick<PreparedSessionSourceAuthority, "release">> = [];
  return withClientVoiceSessionResources(resources, async () => {
    const selected = await captureClientVoiceEntrySource(params, assertLifetimeCurrent);
    resources.push(selected.execution);
    return await runOpenClawAgentWriteAdmission(
      selected.options,
      async () => {
        const { execution, agentId } = selected;
        const requester = await prepareSessionSourceAuthority(params.requester);
        resources.push(requester);
        const borrowedRequester = Object.assign(() => params.requester?.(), {
          prepareSessionSource: async () => ({ ...requester, release: undefined }),
        });
        const source = composeSessionSourceAssertion([borrowedRequester, params.source]);
        const assertPreparationCurrent = () => {
          execution.assertCurrent();
          selected.assertCurrent();
          assertPreparedSessionSourceCurrent(requester);
        };
        const { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseRuntimeFromExecution } =
          await import("../state/openclaw-agent-db.js");
        const apply = async (database: OpenClawAgentDatabase) => {
          await execution.adoptNativeDatabase(database);
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
        return requester.opaqueCommitGuard
          ? withOpenClawAgentDatabaseAsync(selected.options, apply, () => {
              assertPreparationCurrent();
              source();
            })
          : withOpenClawAgentDatabaseRuntimeFromExecution(
              selected.options,
              execution,
              apply,
              assertPreparationCurrent,
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
      ? getSessionActorStorageBinding({ storePath: params.source.storePath })
      : undefined;
    const sourceCandidates =
      params.source && !memorySource
        ? captureSessionStoreReadCandidates(params.source.storePath)
        : [];
    const sourceIdentities = captureSessionStoreCandidateIdentities(sourceCandidates);
    const assertSourceLocatorsCurrent = () => {
      if (!sourceCandidates.every(isSessionStoreReadCandidateCurrent)) {
        throw new Error("Voice session source changed");
      }
    };
    // Reserve accepted order before authority preparation yields, without a native write lock.
    return await runOpenClawAgentWriteAdmission(
      writer.options,
      async () => {
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
          const preparedSources = [
            ...authority.checks.map(({ predicate }) => predicate.source),
            ...(authority.transaction ? [authority.transaction.source] : []),
          ].filter((source) =>
            [...sourceIdentities.values()].some(
              (identity) =>
                typeof source.databaseIdentity === "string" &&
                identity.key === `file:${source.databaseIdentity}` &&
                identity.birthtime === source.databaseBirthtime,
            ),
          );
          const preparedSource = preparedSources.every(
            (source) => source.databaseIdentity === preparedSources[0]?.databaseIdentity,
          )
            ? preparedSources[0]
            : undefined;
          const canonical = resolveUnsuffixedSqliteTargetFromSessionStorePath(
            params.source.storePath,
          );
          // Reuse the prepared physical owner; opaque SDK sources resolve their original selector.
          const sourceTarget =
            preparedSource ??
            (canonical.agentId ||
            (authority.nativeSource &&
              isIncognitoOpenClawAgentSqlitePath(canonical.path, writer.options))
              ? { ...canonical, agentId: canonical.agentId ?? params.agentId }
              : await prepareSqliteTargetFromSessionStorePath(params.source.storePath, {
                  agentId: params.agentId,
                  env: writer.options.env,
                }));
          const sourcePath = assertSessionStoreReadCandidate(sourceTarget.path, sourceCandidates);
          const sourceIdentity = sourceIdentities.get(sourcePath);
          if (!sourceTarget.agentId || !sourceIdentity) {
            throw new Error("Voice session source changed its captured database owner");
          }
          const assertSourceCurrent = () => {
            assertSourceLocatorsCurrent();
            assertSessionStoreReadCandidate(sourceTarget.path, sourceCandidates);
            assertDatabasePathIdentity(sourcePath, sourceIdentity);
          };
          writer.assertCurrent();
          params.assertCurrent?.();
          requester.assertCurrent();
          assertSourceCurrent();
          authority.assertCurrent();
          assertSourceCurrent();
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
            writer.assertCurrent();
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
            checks: sources.checks,
            transaction: authority?.transaction,
            assertCurrent: () => {
              assertSourceLocatorsCurrent();
              assertSourceIdentityCurrent?.();
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
