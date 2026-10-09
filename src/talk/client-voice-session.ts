/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  publishTranscriptUpdate,
} from "../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { captureGatewayRootWorkReleaseObserver } from "../process/gateway-work-admission.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  type ClientVoiceConfirmationUtteranceContext,
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance,
  prepareClientVoiceConfirmationTranscript,
  recordClientVoiceConfirmationTranscriptAppend,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  ClientVoiceMutationDigestOwner,
  createClientVoiceMutationDigestDeliveryOptions,
} from "./client-voice-mutation-digest-owner.js";
import {
  assertClientVoiceSessionAdmission,
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import { lookupClientVoiceSessions } from "./client-voice-session-read.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import {
  assertVoiceSessionOwnership as assertOwnership,
  type ClientVoiceRunBinding,
  operationKey,
  readVoiceSessionRecord as readRecord,
  readVoiceSessionRecordInTransaction as readRecordInTransaction,
  readVoiceSessionFacts,
  readOwnedVoiceSessionFacts,
  recordVoiceToolEffectInTransaction,
  registerVoiceConsultRunInTransaction,
  VOICE_SESSION_RECORD_VERSION as RECORD_VERSION,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
  writeVoiceSessionRecordInTransaction as writeRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  buildPersistedVoiceMessage,
  VoiceTranscriptOperationRegistry,
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_MAX_UNRESOLVED,
  voiceTranscriptEventId,
} from "./voice-transcript.js";

type ClientVoiceRun = {
  binding: ClientVoiceRunBinding;
  source: ClientVoiceSessionSource;
  settlement?: ReturnType<typeof captureClientVoiceSessionSettlement>;
  stopObserving?: () => void;
};

const voiceSessionByRunId = new Map<string, ClientVoiceRun>();
const voiceSessionOperations = new VoiceTranscriptOperationRegistry();
let unsubscribeToolEffects: (() => void) | undefined;
let unsubscribeRunCompletion: (() => void) | undefined;

async function closeVoiceSessionOperationOwner(
  params: Omit<Parameters<typeof closeClientVoiceSessionInternal>[0], "source">,
  retainedSource?: ClientVoiceSessionSource,
): Promise<boolean> {
  const close = async () => {
    const source = retainedSource ?? captureClientVoiceSessionSource(params.agentId);
    let closed: boolean | undefined;
    await voiceSessionOperations.close(
      operationKey(params.agentId, params.voiceSessionId),
      async () => {
        closed = await closeClientVoiceSessionInternal({ ...params, source });
      },
    );
    // A joined recovery close may skip a resumed call; explicit closes need their own barrier.
    if (closed === undefined && params.staleBefore === undefined) {
      return closeVoiceSessionOperationOwner(params, source);
    }
    return closed ?? false;
  };
  return withClientVoiceSessionSettlement(close, undefined, retainedSource?.settlementContext);
}

function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): void {
  const runId = event.runId;
  if (!runId) {
    return;
  }
  const owner = voiceSessionByRunId.get(runId);
  if (!owner) {
    return;
  }
  const { binding, source } = owner;
  const capture = () => captureClientVoiceSessionSettlement(source.settlementContext);
  // An operation failure releases its child, never the run's root-backed custody.
  const settlement = owner.settlement?.run(capture) ?? capture();
  try {
    settlement.run(() => {
      source.assertCurrent();
      runOpenClawAgentWriteTransaction(
        (database) => {
          source.assertCurrent();
          recordVoiceToolEffectInTransaction(database, binding, runId, event);
        },
        source.options,
        { operationLabel: "voice.session.tool-effect" },
      );
    });
  } finally {
    settlement.release();
  }
}

function retireClientVoiceRun(runId: string, owner: ClientVoiceRun, retry = true): void {
  if (voiceSessionByRunId.get(runId) !== owner) {
    return;
  }
  voiceSessionByRunId.delete(runId);
  owner.stopObserving?.();
  try {
    const { binding } = owner;
    releaseClientVoiceConfirmationRun(binding.agentId, binding.voiceSessionId, runId);
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
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent(recordClientVoiceToolEffect);
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

/** Create a call record or resume the same open call across transport restarts. */
export function createOrResumeClientVoiceSession(
  params: {
    agentId: string;
    sessionKey: string;
    provider?: string;
    origin: "client" | "relay";
    transcriptCapable?: boolean;
    voiceSessionId?: string;
    now?: number;
  },
  source?: ClientVoiceSessionSource,
): string {
  assertClientVoiceSessionAdmission(source?.settlementContext);
  const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
  const provider = params.provider?.trim() || undefined;
  const now = params.now ?? Date.now();
  source?.assertCurrent();
  runOpenClawAgentWriteTransaction(
    (database) => {
      source?.assertCurrent();
      const existing = readRecordInTransaction(database, voiceSessionId);
      if (existing) {
        assertOwnership(existing, params);
        if (existing.origin !== params.origin) {
          throw new Error("voice session origin does not match");
        }
        if (existing.status !== "open") {
          throw new Error("voice session is already closed");
        }
        if (existing.provider && provider && existing.provider !== provider) {
          throw new Error("voice session provider does not match");
        }
        if (!existing.provider && provider) {
          existing.provider = provider;
        }
        if (params.transcriptCapable === true) {
          existing.transcriptCapable = true;
        }
        existing.updatedAt = now;
        writeRecordInTransaction(database, existing);
        return;
      }
      writeRecordInTransaction(database, {
        version: RECORD_VERSION,
        voiceSessionId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(provider ? { provider } : {}),
        origin: params.origin,
        ...(params.transcriptCapable === true ? { transcriptCapable: true } : {}),
        status: "open",
        createdAt: now,
        updatedAt: now,
        consultRunIds: [],
        effects: [],
        transcriptFailureKeys: [],
      });
    },
    source?.options ?? { agentId: params.agentId },
    { operationLabel: "voice.session.create-or-resume" },
  );
  return voiceSessionId;
}
/** Read the canonical agent-session id without creating state during provider startup. */
export function resolveClientVoiceAgentSessionId(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
}): string | undefined {
  return loadSessionEntryReadOnly(params)?.sessionId?.trim() || undefined;
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  deadlineAt?: number;
  assertCommitAllowed?: () => void;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
}): Promise<string> {
  const commitGuard = sessionEntryCommitGuardOptions(params.assertCommitAllowed);
  const created = await patchSessionEntryCore(
    params,
    (_entry, context) => {
      if (context.existingEntry?.sessionId) {
        return null;
      }
      if (context.existingEntry) {
        return { sessionId: randomUUID() };
      }
      return buildSessionCreationStamp({
        via: "talk",
        actor: params.creation?.actor ?? { type: "human", source: "unknown" },
        sandbox: params.creation?.sandbox,
      });
    },
    {
      fallbackEntry: mergeSessionEntry(undefined, {}),
      ...commitGuard,
      workerGuard: {
        ...commitGuard.workerGuard,
        assertCurrent: () => {
          // Provider startup can end while this write is queued or being prepared.
          if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
        },
      },
    },
  );
  if (!created?.sessionId) {
    throw new Error(`agent session could not be initialized (${params.sessionKey})`);
  }
  return created.sessionId;
}

export function registerClientVoiceConsultRun(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  runId: string;
  config?: OpenClawConfig;
}): void {
  const previous = voiceSessionByRunId.get(params.runId);
  const sameBinding =
    previous?.binding.agentId === params.agentId &&
    previous.binding.voiceSessionId === params.voiceSessionId &&
    previous.binding.sessionKey === params.sessionKey;
  const source = sameBinding ? previous.source : captureClientVoiceSessionSource(params.agentId);
  const observeRelease = sameBinding ? null : captureGatewayRootWorkReleaseObserver();
  const capture = () => captureClientVoiceSessionSettlement(source.settlementContext);
  const settlement = (sameBinding ? previous.settlement?.run(capture) : undefined) ?? capture();
  let registered: ClientVoiceRun | undefined;
  try {
    settlement.run(() => {
      source.assertCurrent();
      const record = runOpenClawAgentWriteTransaction(
        (database) => {
          source.assertCurrent();
          return registerVoiceConsultRunInTransaction(database, params);
        },
        source.options,
        { operationLabel: "voice.session.register-consult" },
      );
      if (!sameBinding) {
        if (previous) {
          retireClientVoiceRun(params.runId, previous);
        }
        const owner: ClientVoiceRun = {
          binding: Object.freeze({
            agentId: params.agentId,
            voiceSessionId: params.voiceSessionId,
            sessionKey: params.sessionKey,
          }),
          source,
          ...(observeRelease ? { settlement } : {}),
        };
        registered = owner;
        voiceSessionByRunId.set(params.runId, owner);
        owner.stopObserving = observeRelease?.((reason) =>
          retireClientVoiceRun(params.runId, owner, reason === "settled"),
        );
      }
      // Replays re-arm a closed call's digest without replacing its accepted owner.
      if (record.status === "closed" && params.config) {
        mutationDigestDeliveryOwner.record({
          agentId: params.agentId,
          voiceSessionId: params.voiceSessionId,
          context: { config: params.config, source },
        });
      }
      ensureToolEffectSubscription();
    });
  } catch (error) {
    if (registered) {
      retireClientVoiceRun(params.runId, registered, false);
    }
    throw error;
  } finally {
    if (settlement !== registered?.settlement) {
      settlement.release();
    }
  }
}

export function resolveClientVoiceRunBinding(runId?: string): ClientVoiceRunBinding | undefined {
  return runId ? voiceSessionByRunId.get(runId)?.binding : undefined;
}

/** Relays and transcript-capable clients require confirmation; legacy clients keep pre-gate behavior. */
export function isClientVoiceSessionConfirmable(binding: ClientVoiceRunBinding): boolean {
  const record = readVoiceSessionFacts(binding.agentId, binding.voiceSessionId);
  return (
    record?.origin === "relay" ||
    record?.transcriptCapable === true ||
    record?.hasUserTranscript === true
  );
}

export function assertClientVoiceSessionOpen(params: ClientVoiceRunBinding): "client" | "relay" {
  const record = readOwnedVoiceSessionFacts(params);
  if (record.status !== "open") {
    throw new Error("voice session is closed");
  }
  return record.origin;
}

/** Validate durable ownership without rejecting an idempotent close retry. */
export function resolveClientVoiceSessionOrigin(params: ClientVoiceRunBinding): "client" | "relay" {
  return readOwnedVoiceSessionFacts(params).origin;
}

/** Resolve the unique open client-owned call for legacy tool-call clients. */
export async function resolveOpenClientVoiceSessionId(params: {
  agentId: string;
  sessionKey: string;
}): Promise<string | undefined> {
  const matches = await lookupClientVoiceSessions({ kind: "legacy", ...params });
  return matches.length === 1 ? matches[0]?.voiceSessionId : undefined;
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
    confirmation?: ClientVoiceConfirmationUtteranceContext | null;
  },
  retainedSource?: ClientVoiceSessionSource,
): Promise<void> {
  // Normalize before admission so the queued task retains only bounded text.
  const normalized = { ...params, text: normalizeVoiceTranscriptText(params.text) };
  if (!normalized.text) {
    return Promise.resolve();
  }
  const confirmation =
    normalized.role === "user"
      ? prepareClientVoiceConfirmationTranscript({
          agentId: normalized.agentId,
          voiceSessionId: normalized.voiceSessionId,
          entryId: normalized.entryId,
          confirmation: normalized.confirmation,
        })
      : null;
  const append = async () => {
    const source = retainedSource ?? captureClientVoiceSessionSource(normalized.agentId);
    return voiceSessionOperations.run(
      operationKey(normalized.agentId, normalized.voiceSessionId),
      async () => {
        source.assertCurrent();
        const record = readRecord(normalized.agentId, normalized.voiceSessionId, source.options);
        if (!record) {
          throw new Error("voice session not found");
        }
        assertOwnership(record, normalized);
        if (record.status !== "open") {
          throw new Error("voice session is closed");
        }
        if (record.origin !== normalized.origin) {
          throw new Error("voice session origin does not allow this transcript source");
        }
        const failureKey = sha256Hex(normalized.entryId);
        if (
          record.transcriptFailureKeys.length >= VOICE_TRANSCRIPT_MAX_UNRESOLVED &&
          !record.transcriptFailureKeys.includes(failureKey)
        ) {
          throw new Error("voice transcript persistence has too many unresolved entries");
        }
        // Voice ownership keeps the original key; transcript storage uses the target
        // prepared before main/global aliases lose their selected agent identity.
        const sessionTarget = {
          ...normalized.sessionTarget,
          agentId: normalized.agentId,
          env: source.options.env,
        };
        const sessionEntry = loadSessionEntryReadOnly(sessionTarget);
        if (!sessionEntry?.sessionId) {
          throw new Error(`agent session not found (${normalized.sessionKey})`);
        }
        const timestamp = normalized.timestamp ?? Date.now();
        // Reserve before the fallible append. A crash can leave a conservative
        // retry requirement, but can never let close skip an accepted entry.
        source.assertCurrent();
        runOpenClawAgentWriteTransaction(
          (database) => {
            source.assertCurrent();
            const current = readRecordInTransaction(database, normalized.voiceSessionId);
            if (!current) {
              throw new Error("voice session disappeared during transcript reservation");
            }
            assertOwnership(current, normalized);
            if (!current.transcriptFailureKeys.includes(failureKey)) {
              current.transcriptFailureKeys.push(failureKey);
            }
            current.updatedAt = Date.now();
            writeRecordInTransaction(database, current);
          },
          source.options,
          { operationLabel: "voice.transcript.reserve" },
        );
        const appended = await appendTranscriptMessage(
          { ...sessionTarget, sessionId: sessionEntry.sessionId },
          {
            ...(normalized.config ? { config: normalized.config } : {}),
            eventId: voiceTranscriptEventId(normalized.voiceSessionId, normalized.entryId),
            message: buildPersistedVoiceMessage({
              role: normalized.role,
              text: normalized.text,
              timestamp,
              provider: record.provider ?? "realtime",
            }),
            now: timestamp,
          },
        );
        // Publish the committed row before fallible bookkeeping; a retry can deduplicate it.
        if (confirmation) {
          recordClientVoiceConfirmationTranscriptAppend({
            confirmation,
            entryId: normalized.entryId,
            text: normalized.text,
            appended: appended.appended,
          });
        }
        if (appended.appended) {
          await publishTranscriptUpdate(
            { ...sessionTarget, sessionId: sessionEntry.sessionId },
            { message: appended.message, messageId: appended.messageId },
          );
        }
        source.assertCurrent();
        runOpenClawAgentWriteTransaction(
          (database) => {
            source.assertCurrent();
            const current = readRecordInTransaction(database, normalized.voiceSessionId);
            if (!current) {
              throw new Error("voice session disappeared during transcript append");
            }
            assertOwnership(current, normalized);
            // Reaching here means this exact eventId is durably persisted (fresh append or
            // idempotent dedup of our own prior write). Arm confirmation bookkeeping in both
            // cases so a retry after a partial failure still records the user utterance.
            if (normalized.role === "user") {
              current.hasUserTranscript = true;
            }
            current.transcriptFailureKeys = current.transcriptFailureKeys.filter(
              (key) => key !== failureKey,
            );
            current.updatedAt = Date.now();
            writeRecordInTransaction(database, current);
          },
          source.options,
          { operationLabel: "voice.transcript.confirm" },
        );
        if (normalized.role === "user" && confirmation) {
          noteClientVoiceConfirmationUtterance({
            agentId: normalized.agentId,
            voiceSessionId: normalized.voiceSessionId,
            timestamp: Date.now(),
            confirmation,
          });
        }
      },
      { weight: normalized.text.length },
    );
  };
  return withClientVoiceSessionSettlement(append, undefined, retainedSource?.settlementContext);
}

/** Append one finalized client-owned transcript item idempotently. */
export function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  source?: ClientVoiceSessionSource,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "client" }, source);
}

/** Wait for the accepted transcript/effect prefix without closing the logical call. */
export async function flushClientVoiceSessionWrites(params: {
  agentId: string;
  voiceSessionId: string;
}): Promise<void> {
  await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
}

/** Append one finalized relay-owned transcript item idempotently. */
export function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
  source?: ClientVoiceSessionSource,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "relay" }, source);
}

const digestOptions = createClientVoiceMutationDigestDeliveryOptions(
  (record) =>
    record.consultRunIds.some((runId) => {
      const binding = voiceSessionByRunId.get(runId)?.binding;
      return (
        binding?.agentId === record.agentId &&
        binding.voiceSessionId === record.voiceSessionId &&
        binding.sessionKey === record.sessionKey
      );
    }),
  captureClientVoiceSessionSettlement,
);
const mutationDigestDeliveryOwner = new ClientVoiceMutationDigestOwner(digestOptions);

async function closeClientVoiceSessionInternal(params: {
  source: ClientVoiceSessionSource;
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  transcriptFailurePolicy: "require-success" | "retain-and-close";
  now?: number;
  staleBefore?: number;
}): Promise<boolean> {
  const now = params.now ?? Date.now();
  params.source.assertCurrent();
  const closed = runOpenClawAgentWriteTransaction(
    (database) => {
      params.source.assertCurrent();
      const current = readRecordInTransaction(database, params.voiceSessionId);
      if (!current) {
        throw new Error("voice session disappeared during close");
      }
      assertOwnership(current, params);
      // Recovery candidates can be resumed while the reader or close queue is awaiting work.
      if (
        params.staleBefore !== undefined &&
        (current.status !== "open" || current.updatedAt > params.staleBefore)
      ) {
        return undefined;
      }
      if (
        current.transcriptFailureKeys.length > 0 &&
        params.transcriptFailurePolicy === "require-success"
      ) {
        throw new Error("voice transcript persistence must be retried before close");
      }
      if (params.transcriptFailurePolicy === "retain-and-close" && current.origin !== "relay") {
        throw new Error("only relay voice sessions may close with unresolved transcripts");
      }
      if (current.status === "open") {
        current.status = "closed";
        current.closedAt = now;
        current.updatedAt = now;
        writeRecordInTransaction(database, current);
      }
      return current;
    },
    params.source.options,
    { operationLabel: "voice.session.close" },
  );
  if (!closed) {
    return false;
  }
  // Transport close does not end consult runs: live bindings keep effect capture active,
  // approved grants stay valid for those runs, and the digest waits for the last accepted run to release its root.
  const liveRunIds = closed.consultRunIds.filter((runId) => {
    const binding = voiceSessionByRunId.get(runId)?.binding;
    return binding?.voiceSessionId === params.voiceSessionId && binding.agentId === params.agentId;
  });
  deactivateClientVoiceConfirmationSession(params.agentId, params.voiceSessionId, liveRunIds);
  // Record retry ownership only after canonical close and confirmation cleanup.
  // Channel delivery is best-effort and must never delay this durable boundary.
  mutationDigestDeliveryOwner.record({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    context: { config: params.config, source: params.source },
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
  },
  source?: ClientVoiceSessionSource,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "require-success",
    },
    source,
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
  source?: ClientVoiceSessionSource,
): Promise<void> {
  await closeVoiceSessionOperationOwner(
    {
      ...params,
      transcriptFailurePolicy: "retain-and-close",
    },
    source,
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
  const source = captureClientVoiceSessionSource(params.agentId);
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  mutationDigestDeliveryOwner.retryAgent(params.agentId, {
    config: params.config,
    source,
  });
  const stale = await lookupClientVoiceSessions(
    {
      kind: "stale",
      agentId: params.agentId,
      updatedBefore: now - STALE_AFTER_MS,
      excludeVoiceSessionId: params.excludeVoiceSessionId,
    },
    source.options,
  );
  let closed = 0;
  for (const record of stale) {
    try {
      const didClose = await closeVoiceSessionOperationOwner(
        {
          agentId: params.agentId,
          sessionKey: record.sessionKey,
          voiceSessionId: record.voiceSessionId,
          config: params.config,
          now,
          staleBefore: now - STALE_AFTER_MS,
          transcriptFailurePolicy: "require-success",
        },
        source,
      );
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
