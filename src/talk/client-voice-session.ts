/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  appendTranscriptMessage,
  publishTranscriptUpdate,
} from "../config/sessions/session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import type { SessionTranscriptWriteScope } from "../config/sessions/session-accessor.types.js";
import { isNativeSessionEntryRead } from "../config/sessions/session-entry-read-request.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { captureGatewayRootWorkReleaseObserver } from "../process/gateway-work-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  ClientVoiceMutationDigestOwner,
  createClientVoiceMutationDigestDeliveryOptions,
} from "./client-voice-mutation-digest-owner.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
  withClientVoiceSessionResources,
} from "./client-voice-session-lifecycle.js";
import { lookupClientVoiceSessions } from "./client-voice-session-read.js";
import {
  captureClientVoiceSessionSource,
  matchesClientVoiceRunSource,
  type ClientVoiceSessionSource,
  type ClientVoiceRun,
} from "./client-voice-session-source.js";
import {
  type ClientVoiceRunBinding,
  type ClientVoiceSessionRecord,
  operationKey,
  readVoiceSessionRecord as readRecord,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
} from "./client-voice-session-store.js";
import {
  captureClientVoiceSessionWriter,
  mutateAuthorizedClientVoiceSession,
  type ClientVoiceSessionMutationAuthority,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-write.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";
import {
  buildPersistedVoiceMessage,
  VoiceTranscriptOperationRegistry,
  normalizeVoiceTranscriptText,
  voiceTranscriptEventId,
} from "./voice-transcript.js";

const voiceSessionByRunId = new Map<string, ClientVoiceRun>();
const voiceSessionOperations = new VoiceTranscriptOperationRegistry();
let unsubscribeToolEffects: (() => void) | undefined;
let unsubscribeRunCompletion: (() => void) | undefined;

async function closeVoiceSessionOperationOwner(
  params: Omit<Parameters<typeof closeClientVoiceSessionInternal>[0], "writer">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<boolean> {
  return withClientVoiceSessionSettlement(
    async () => {
      const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
      const resources = retainedWriter ? [] : [writer];
      return withClientVoiceSessionResources(resources, async () => {
        let closed: boolean | undefined;
        await voiceSessionOperations.close(
          operationKey(params.agentId, params.voiceSessionId),
          async () => {
            closed = await closeClientVoiceSessionInternal({ ...params, writer });
          },
        );
        // A joined recovery close may skip a resumed call; explicit closes need their own barrier.
        if (closed === undefined && params.staleBefore === undefined) {
          return await closeVoiceSessionOperationOwner(params, writer);
        }
        return closed ?? false;
      });
    },
    undefined,
    params.physicalSource?.settlementContext ?? retainedWriter?.settlementContext,
  );
}

async function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): Promise<void> {
  const owner = event.runId ? voiceSessionByRunId.get(event.runId) : undefined;
  if (!owner) {
    return;
  }
  const { binding, source } = owner;
  // Capture the source and enqueue synchronously, before run.completed can retire its binding.
  try {
    await runWithClientVoiceRunSettlement(owner, () =>
      withClientVoiceSessionSettlement(
        async () => {
          const writer = captureClientVoiceSessionWriter({ ...binding, physicalSource: source });
          await withClientVoiceSessionResources([writer], () =>
            writer.mutate({ ...binding, kind: "effect", event, now: Date.now() }),
          );
        },
        undefined,
        source.settlementContext,
      ),
    );
  } catch (error) {
    console.warn(`[talk] voice tool effect persistence failed: ${String(error)}`);
  }
}

function runWithClientVoiceRunSettlement<T>(owner: ClientVoiceRun, run: () => T): T {
  const capture = () => captureClientVoiceSessionSettlement(owner.source.settlementContext);
  // The child admits the asynchronous operation before releasing its synchronous grant.
  const settlement = owner.settlement?.run(capture) ?? capture();
  try {
    return settlement.run(run);
  } finally {
    settlement.release();
  }
}

function retireClientVoiceRun(runId: string, owner: ClientVoiceRun, retry = true): void {
  if (voiceSessionByRunId.get(runId) !== owner) {
    return;
  }
  owner.retired = true;
  voiceSessionByRunId.delete(runId);
  owner.stopObserving?.();
  try {
    const { binding } = owner;
    if (retry) {
      const retryDigest = () => mutationDigestDeliveryOwner.retry(binding);
      if (owner.settlement) {
        owner.settlement.run(retryDigest);
      } else {
        retryDigest();
      }
    }
  } finally {
    owner.settlement?.release();
  }
}

function ensureToolEffectSubscription(): void {
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent((event) => {
    void recordClientVoiceToolEffect(event);
  });
  unsubscribeRunCompletion ??= onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "run.completed") {
        return;
      }
      const owner = voiceSessionByRunId.get(event.runId);
      // Root-backed runs include queued and yielded work beyond diagnostic completion.
      if (!owner || owner.settlement) {
        return;
      }
      retireClientVoiceRun(event.runId, owner);
    },
    { include: ["run.completed"] },
  );
}

export { createOrResumeClientVoiceSession } from "./client-voice-session-write.js";

/** Correlate a consult run with its open call for voice identity and mutation evidence. */
export async function registerClientVoiceConsultRun(
  input: ClientVoiceSessionMutationAuthority & {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    runId: string;
    config?: OpenClawConfig;
    physicalSource?: ClientVoiceSessionSource;
    onRegistered?: (release: () => void) => void;
  },
): Promise<() => void> {
  const params = { ...input };
  const previous = voiceSessionByRunId.get(params.runId);
  const sameBinding =
    previous !== undefined && matchesClientVoiceRunSource(previous, params, params.physicalSource);
  const writer = sameBinding
    ? runWithClientVoiceRunSettlement(previous, () =>
        captureClientVoiceSessionWriter({
          ...params,
          physicalSource: params.physicalSource ?? previous.source,
        }),
      )
    : captureClientVoiceSessionWriter(params);
  const observeRelease = captureGatewayRootWorkReleaseObserver();
  const capture = () => captureClientVoiceSessionSettlement(writer.settlementContext);
  let settlement: ReturnType<typeof capture> | undefined;
  let registered: ClientVoiceRun | undefined;
  return withClientVoiceSessionResources(
    () => (settlement && settlement !== registered?.settlement ? [settlement, writer] : [writer]),
    async () => {
      try {
        settlement = (sameBinding ? previous.settlement?.run(capture) : undefined) ?? capture();
        const accepted = settlement;
        return await accepted.run(() => {
          const mutation: VoiceSessionMutation = {
            kind: "consult",
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId: params.voiceSessionId,
            runId: params.runId,
            now: Date.now(),
          };
          const publish = (record: ClientVoiceSessionRecord | undefined) => {
            const source = writer.source;
            // A queued replay still commits, but cannot revive its retired run owner.
            const retired = sameBinding && previous.retired;
            let owner = retired ? undefined : voiceSessionByRunId.get(params.runId);
            if (!retired && !matchesClientVoiceRunSource(owner, params, source)) {
              if (owner) {
                retireClientVoiceRun(params.runId, owner);
              }
              owner = {
                binding: Object.freeze({
                  agentId: params.agentId,
                  voiceSessionId: params.voiceSessionId,
                  sessionKey: params.sessionKey,
                }),
                source,
                ...(observeRelease ? { settlement: accepted } : {}),
              };
              registered = owner;
              voiceSessionByRunId.set(params.runId, owner);
              const published = owner;
              owner.stopObserving = observeRelease?.((reason) =>
                retireClientVoiceRun(params.runId, published, reason === "settled"),
              );
            }
            // Replays re-arm a closed call's digest without replacing its accepted owner.
            if (record?.status === "closed" && params.config) {
              mutationDigestDeliveryOwner.record({
                agentId: params.agentId,
                voiceSessionId: params.voiceSessionId,
                context: {
                  config: params.config,
                  source: owner?.source ?? (sameBinding ? previous.source : source),
                },
              });
            }
            ensureToolEffectSubscription();
            const release = () => {
              if (owner) {
                retireClientVoiceRun(params.runId, owner);
              }
            };
            // Publish cleanup with the binding, before resource release can suspend.
            params.onRegistered?.(release);
            return release;
          };
          // Standalone guards stay in the captured writer's admission checks.
          return params.requester || params.source
            ? mutateAuthorizedClientVoiceSession(params, writer, () => mutation, publish)
            : writer.mutate(mutation, publish);
        });
      } catch (error) {
        if (registered) {
          try {
            retireClientVoiceRun(params.runId, registered, false);
          } catch (releaseError) {
            throw createSqliteLifecycleAggregateError(
              [error, releaseError],
              "Voice session registration and cleanup failed",
              error,
            );
          }
        }
        throw error;
      }
    },
  );
}

/** Return the open voice-call binding for one executing run. */
export function resolveClientVoiceRunBinding(runId?: string): ClientVoiceRunBinding | undefined {
  return runId ? voiceSessionByRunId.get(runId)?.binding : undefined;
}

function appendVoiceTranscript(
  params: {
    agentId: string;
    sessionKey: string;
    sessionTarget: { sessionKey: string; storePath?: string };
    voiceSessionId: string;
    origin: "client" | "relay";
    entryId: string;
    role: "user" | "assistant";
    text: string;
    timestamp?: number;
    config?: OpenClawConfig;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  // Normalize before admission so the queued task retains only bounded text.
  const normalized = {
    ...params,
    sessionTarget: { ...params.sessionTarget },
    text: normalizeVoiceTranscriptText(params.text),
  };
  if (!normalized.text) {
    return Promise.resolve();
  }
  return withClientVoiceSessionSettlement(
    async () => {
      const writer = retainedWriter ?? captureClientVoiceSessionWriter(normalized);
      const resources = retainedWriter ? [] : [writer];
      return withClientVoiceSessionResources(resources, async () => {
        await voiceSessionOperations.run(
          operationKey(normalized.agentId, normalized.voiceSessionId),
          async () => {
            const sessionTarget = {
              ...normalized.sessionTarget,
              agentId: normalized.agentId,
              env: writer.options.env,
            };
            const failureKey = sha256Hex(normalized.entryId);
            const timestamp = normalized.timestamp ?? Date.now();
            const reservation = {
              agentId: normalized.agentId,
              sessionKey: normalized.sessionKey,
              voiceSessionId: normalized.voiceSessionId,
              origin: normalized.origin,
              kind: "reserve" as const,
              failureKey,
              now: Date.now(),
            };
            const appendReserved = async (
              record: ClientVoiceSessionRecord | undefined,
              entry: InternalSessionEntry | undefined,
              target: SessionTranscriptWriteScope,
              assertFresh: () => void,
              workerTranscript = false,
            ) => {
              if (!record) {
                throw new Error("voice session not found");
              }
              if (!entry?.sessionId) {
                throw new Error(`agent session not found (${normalized.sessionKey})`);
              }
              const transcriptTarget = { ...target, sessionId: entry.sessionId };
              const messageOptions = {
                ...(normalized.config ? { config: normalized.config } : {}),
                eventId: voiceTranscriptEventId(normalized.voiceSessionId, normalized.entryId),
                message: buildPersistedVoiceMessage({
                  role: normalized.role,
                  text: normalized.text,
                  timestamp,
                  provider: record.provider ?? "realtime",
                }),
                now: timestamp,
              };
              const turn = workerTranscript
                ? await appendExpectedSessionTranscriptTurn(transcriptTarget, {
                    config: normalized.config,
                    keyFormat: "agent-qualified",
                    expectedSessionId: entry.sessionId,
                    selectedSessionId: entry.sessionId,
                    selectedLifecycleRevision: entry.lifecycleRevision,
                    sessionFile: normalized.sessionTarget.sessionKey,
                    assertCurrent: assertFresh,
                    messages: [messageOptions],
                    voiceTranscript: {
                      agentId: normalized.agentId,
                      sessionKey: normalized.sessionKey,
                      voiceSessionId: normalized.voiceSessionId,
                      failureKey,
                      role: normalized.role,
                    },
                  })
                : undefined;
              const appended = workerTranscript
                ? turn?.appendedMessages[0]
                : await appendTranscriptMessage(transcriptTarget, {
                    ...messageOptions,
                    preparation: { source: composeSessionSourceAssertion([assertFresh]) },
                  });
              if (!appended) {
                throw new Error("agent session changed before voice transcript append");
              }
              // The worker publishes the transcript and its bookkeeping only after their shared commit.
              if (appended.appended) {
                await publishTranscriptUpdate(transcriptTarget, {
                  message: appended.message,
                  messageId: appended.messageId,
                });
                assertFresh();
              }

              if (!workerTranscript) {
                await writer.mutate({
                  agentId: normalized.agentId,
                  sessionKey: normalized.sessionKey,
                  voiceSessionId: normalized.voiceSessionId,
                  kind: "confirm",
                  role: normalized.role,
                  failureKey,
                  now: Date.now(),
                });
              }
            };
            const nativeTranscript = isNativeSessionEntryRead(sessionTarget, normalized.agentId);
            const transcriptStore = resolveUnsuffixedSqliteTargetFromSessionStorePath(
              sessionTarget.storePath ||
                resolveOpenClawAgentSqlitePath({
                  agentId: normalized.agentId,
                  env: writer.options.env,
                }),
            );
            const sharesVoiceStore =
              !nativeTranscript &&
              (transcriptStore.agentId || transcriptStore.shared) &&
              transcriptStore.path === writer.options.path;
            if (sharesVoiceStore) {
              // Entry preparation and failure reservation share their authoritative transaction.
              const prepared = await writer.mutate(
                { ...reservation, transcriptSessionKey: sessionTarget.sessionKey },
                (record, entry) => ({ record, entry }),
              );
              await appendReserved(
                prepared.record,
                prepared.entry,
                {
                  ...sessionTarget,
                  storePath: writer.options.path,
                },
                writer.assertCurrent,
                true,
              );
            } else {
              // Custom and native incognito transcripts keep their separately selected source.
              await withSessionEntryReadOnlyInWorker(
                sessionTarget,
                writer.assertCurrent,
                async (read, source) => {
                  if (!read.ok) {
                    throw read.error;
                  }
                  if (!read.value?.sessionId) {
                    throw new Error(`agent session not found (${normalized.sessionKey})`);
                  }
                  const physicalSource = source.scope?.storePath
                    ? readDatabasePathIdentitySync(source.scope.storePath)
                    : undefined;
                  const record = await writer.mutate(reservation);
                  source.assertCurrent();
                  await appendReserved(
                    record,
                    read.value,
                    { ...sessionTarget, ...source.scope },
                    () => {
                      writer.assertCurrent();
                      // Canonical reader continuations cannot enter the append's transaction.
                      if (physicalSource) {
                        assertExistingDatabaseIdentity(
                          physicalSource.canonicalPath,
                          physicalSource.key,
                          physicalSource.birthtime,
                        );
                      }
                    },
                    !nativeTranscript &&
                      physicalSource?.key === writer.identity.key &&
                      physicalSource.birthtime === writer.identity.birthtime,
                  );
                },
              );
            }
          },
          { weight: normalized.text.length },
        );
      });
    },
    undefined,
    retainedWriter?.settlementContext,
  );
}

/** Append one finalized client-owned transcript item idempotently. */
export function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "client" }, retainedWriter);
}

/** Wait for the accepted transcript/effect prefix without closing the logical call. */
export async function flushClientVoiceSessionWrites(
  params: {
    agentId: string;
    voiceSessionId: string;
  },
  retainedWriter?: ClientVoiceSessionWriter | null,
): Promise<void> {
  // Failed source admission may join accepted transcripts, never recapture a writer.
  if (retainedWriter === null) {
    await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
    return;
  }
  const writer = retainedWriter ?? captureClientVoiceSessionWriter(params);
  const resources = retainedWriter ? [] : [writer];
  await withClientVoiceSessionResources(resources, async () => {
    await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
    // Join the accepted agent-writer prefix, including synchronous diagnostic producers.
    await runOpenClawAgentWriteAdmission(writer.options, () => writer.assertCurrent());
  });
}

/** Append one finalized relay-owned transcript item idempotently. */
export function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "relay" }, retainedWriter);
}

const digestOptions = createClientVoiceMutationDigestDeliveryOptions(
  () => voiceSessionByRunId,
  captureClientVoiceSessionSettlement,
);
const mutationDigestDeliveryOwner = new ClientVoiceMutationDigestOwner(digestOptions);

async function closeClientVoiceSessionInternal(params: {
  writer: ClientVoiceSessionWriter;
  physicalSource?: ClientVoiceSessionSource;
  expectedOrigin?: "client";
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  transcriptFailurePolicy: "require-success" | "retain-and-close";
  now?: number;
  staleBefore?: number;
}): Promise<boolean> {
  const now = params.now ?? Date.now();
  const closed = await params.writer.mutate({
    kind: "close",
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    voiceSessionId: params.voiceSessionId,
    transcriptFailurePolicy: params.transcriptFailurePolicy,
    expectedOrigin: params.expectedOrigin,
    staleBefore: params.staleBefore,
    now,
  });
  if (!closed) {
    return false;
  }
  // Channel delivery is best-effort and must never delay this durable boundary.
  mutationDigestDeliveryOwner.record({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    context: { config: params.config, source: params.writer.source },
  });
  return true;
}

/** Close a logical voice call after its accepted transcript prefix is durable. */
export async function closeClientVoiceSession(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
    now?: number;
    expectedOrigin?: "client";
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "require-success",
    },
    retainedWriter,
  );
}

/**
 * Terminally close a relay call after its bounded append retries settle.
 * Relays have no payload replay owner after teardown, so unresolved hashes remain as audit state.
 */
export async function closeRelayVoiceSessionRecord(
  params: {
    agentId: string;
    sessionKey: string;
    voiceSessionId: string;
    config: OpenClawConfig;
    now?: number;
  },
  retainedWriter?: ClientVoiceSessionWriter,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "retain-and-close",
    },
    retainedWriter,
  );
}

/** Close abandoned open calls idle for the fixed six-hour recovery window. */
export async function closeStaleClientVoiceSessions(params: {
  agentId: string;
  config: OpenClawConfig;
  excludeVoiceSessionId?: string;
  now?: number;
  warn?: (message: string) => void;
}): Promise<number> {
  const now = params.now ?? Date.now();
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  const physicalSource = captureClientVoiceSessionSource(params.agentId);
  mutationDigestDeliveryOwner.retryAgent(params.agentId, {
    config: params.config,
    source: physicalSource,
  });
  const stale = await lookupClientVoiceSessions(
    {
      kind: "stale",
      agentId: params.agentId,
      updatedBefore: now - STALE_AFTER_MS,
      excludeVoiceSessionId: params.excludeVoiceSessionId,
    },
    physicalSource.options,
  );
  let closed = 0;
  for (const record of stale) {
    try {
      const didClose = await closeVoiceSessionOperationOwner({
        agentId: params.agentId,
        physicalSource,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        config: params.config,
        now,
        staleBefore: now - STALE_AFTER_MS,
        transcriptFailurePolicy: "require-success",
      });
      if (didClose) {
        closed += 1;
      }
    } catch (error) {
      params.warn?.(
        `failed to close stale voice session ${record.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}

const clientVoiceSessionTesting = {
  readRecord,
  digestDeliveryPolicy: CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  digestDeliverySnapshot: () => mutationDigestDeliveryOwner.snapshot(),
  reset(): void {
    for (const [runId, owner] of voiceSessionByRunId) {
      retireClientVoiceRun(runId, owner, false);
    }
    voiceSessionOperations.clear();
    mutationDigestDeliveryOwner.clear();
    unsubscribeToolEffects?.();
    unsubscribeToolEffects = undefined;
    unsubscribeRunCompletion?.();
    unsubscribeRunCompletion = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.clientVoiceSessionTestApi")] =
    clientVoiceSessionTesting;
}
