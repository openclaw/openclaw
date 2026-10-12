import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { captureSessionStoreCandidateIdentities } from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets-session.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { withClientVoiceSessionResources } from "./client-voice-session-lifecycle.js";
import type { ClientVoiceSessionSource } from "./client-voice-session-source.js";
import {
  type ClientVoiceSessionRecord,
  type ClientVoiceRunBinding,
  operationKey,
} from "./client-voice-session-store.js";
import {
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "./client-voice-session-write.js";

const loadMessageRuntime = createLazyRuntimeModule(() => import("../channels/message/runtime.js"));

export const CLIENT_VOICE_MUTATION_DIGEST_POLICY = {
  maxRetainedIntents: 64,
  maxRetainedIdentityBytes: 64 * 1024,
  maxConcurrentAttempts: 2,
  maxAttemptFailures: 3,
  attemptAbortAfterMs: 30_000,
  failureRetentionMs: 5 * 60_000,
} as const;

function formatMutationDigest(effects: ClientVoiceSessionRecord["effects"]): string | undefined {
  if (effects.length === 0) {
    return undefined;
  }
  return [
    "Voice call changes",
    ...effects
      .slice(0, 12)
      .map(
        (effect) =>
          `- ${effect.toolName}: ${effect.status === "started" ? "outcome not confirmed" : effect.status}`,
      ),
  ].join("\n");
}

type MutationDigestConversation = {
  storePath: string;
  identities: ReturnType<typeof captureSessionStoreCandidateIdentities>;
  selected?: DatabasePathIdentity;
};

type MutationDigestDelivery = {
  confirmed?: ClientVoiceRunBinding & { deliveredAt: number };
  mayHaveReachedRecipient?: true;
};

/** A confirmed send survives marker retries without re-entering the sender. */
async function deliverClientVoiceMutationDigest(
  record: ClientVoiceSessionRecord,
  config: OpenClawConfig,
  signal: AbortSignal,
  writer: ClientVoiceSessionWriter,
  delivery: MutationDigestDelivery,
  preparedEntry: InternalSessionEntry | undefined,
  conversation: MutationDigestConversation,
): Promise<void> {
  if (record.digestDeliveredAt) {
    return;
  }
  if (!delivery.confirmed) {
    const text = formatMutationDigest(record.effects);
    if (!text) {
      return;
    }
    const assertCurrent = () => {
      writer.assertCurrent();
      const selected = conversation.selected;
      if (selected) {
        assertExistingDatabaseIdentity(selected.canonicalPath, selected.key, selected.birthtime);
      }
    };
    const send = async (entry: InternalSessionEntry | undefined, assertReadCurrent: () => void) => {
      if (!entry) {
        throw new Error(`Voice mutation digest conversation not found (${record.sessionKey})`);
      }
      const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
      if (!target.channel || target.channel === "webchat" || !target.to) {
        return;
      }
      const { sendDurableMessageBatchCore, durableMessageBatchMayHaveReachedRecipient } =
        await loadMessageRuntime();
      assertCurrent();
      assertReadCurrent();
      signal.throwIfAborted();
      const result = await sendDurableMessageBatchCore({
        cfg: config,
        channel: target.channel,
        to: target.to,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        ...(target.threadId != null ? { threadId: target.threadId } : {}),
        payloads: [{ text }],
        durability: "required",
        requireUnknownSendReconciliation: true,
        signal,
        session: buildOutboundSessionContext({
          cfg: config,
          agentId: record.agentId,
          sessionKey: record.sessionKey,
          policySessionKey: record.sessionKey,
        }),
      });
      if (durableMessageBatchMayHaveReachedRecipient(result)) {
        delivery.mayHaveReachedRecipient = true;
      }
      if (result.status === "failed" || result.status === "partial_failed") {
        throw result.error;
      }
      if (result.status === "suppressed" && delivery.mayHaveReachedRecipient) {
        throw new Error("voice mutation digest delivery outcome is uncertain");
      }
      delivery.confirmed = {
        agentId: record.agentId,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        deliveredAt: Date.now(),
      };
    };
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(conversation.storePath);
    const captured = conversation.identities.get(writer.identity.canonicalPath);
    // The metadata read already carries delivery facts for its unambiguous canonical conversation.
    if (
      !isIncognitoSessionKey(record.sessionKey) &&
      target.agentId === record.agentId &&
      target.path === writer.options.path &&
      captured?.key === writer.identity.key &&
      captured.birthtime === writer.identity.birthtime
    ) {
      conversation.selected ??= captured;
      await send(preparedEntry, assertCurrent);
    } else {
      await withSessionEntryReadOnlyInWorker(
        {
          agentId: record.agentId,
          sessionKey: record.sessionKey,
          storePath: conversation.selected?.canonicalPath ?? conversation.storePath,
          env: writer.options.env,
          projection: "list",
        },
        assertCurrent,
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          if (owner.scope && !conversation.selected) {
            const selected = readDatabasePathIdentitySync(owner.scope.storePath);
            const original = conversation.identities.get(selected.canonicalPath);
            if (!original) {
              throw new Error("Voice mutation digest conversation store changed before delivery");
            }
            assertExistingDatabaseIdentity(
              selected.canonicalPath,
              original.key,
              original.birthtime,
            );
            conversation.selected = selected;
          }
          await send(read.value, () => owner.assertCurrent());
        },
      );
    }
    if (!delivery.confirmed) {
      return;
    }
  }
  await writer.mutate({ ...delivery.confirmed, kind: "delivered", now: Date.now() });
}

type MutationDigestIntent<TContext> = {
  agentId: string;
  voiceSessionId: string;
  context: TContext;
  identityBytes: number;
  failedAttempts: number;
  retryBlocked?: true;
  failureExpiry?: ReturnType<typeof setTimeout>;
  expireAfterActive?: boolean;
  queuedSettlement?: MutationDigestSettlement;
};

type MutationDigestSettlement = {
  run: <T>(run: () => T) => T;
  release: () => void;
};

type MutationDigestOptions<TContext> = {
  attempt: (intent: {
    agentId: string;
    voiceSessionId: string;
    context: TContext;
    signal: AbortSignal;
  }) => Promise<boolean>;
  warn: (message: string) => void;
  captureAttempt?: (context: TContext) => MutationDigestSettlement;
  matchesRetryContext?: (previous: TContext, next: TContext) => boolean;
  deliveryState?: (context: TContext) => "unsent" | "confirmed" | "uncertain";
  updateContext?: (previous: TContext, next: TContext) => TContext;
};

export class ClientVoiceMutationDigestOwner<TContext> {
  private readonly intents = new Map<string, MutationDigestIntent<TContext>>();
  private readonly pendingKeys = new Set<string>();
  private readonly retryAfterActiveKeys = new Set<string>();
  private readonly activeAttempts = new Map<string, AbortController>();
  private retainedIdentityBytes = 0;
  private readonly policy = CLIENT_VOICE_MUTATION_DIGEST_POLICY;

  constructor(private readonly options: MutationDigestOptions<TContext>) {}

  record(params: { agentId: string; voiceSessionId: string; context: TContext }): void {
    const key = operationKey(params.agentId, params.voiceSessionId);
    const existing = this.intents.get(key);
    if (existing?.retryBlocked) {
      return;
    }
    if (existing) {
      existing.context =
        this.options.updateContext?.(existing.context, params.context) ?? params.context;
      this.retry(params);
      return;
    }
    const identityBytes =
      Buffer.byteLength(params.agentId, "utf8") +
      Buffer.byteLength(params.voiceSessionId, "utf8") +
      1;
    if (identityBytes > this.policy.maxRetainedIdentityBytes) {
      this.options.warn("voice mutation digest identity exceeds the retry owner byte limit");
      return;
    }
    if (
      this.intents.size >= this.policy.maxRetainedIntents ||
      this.retainedIdentityBytes + identityBytes > this.policy.maxRetainedIdentityBytes
    ) {
      this.options.warn("voice mutation digest retry owner is full");
      return;
    }
    const intent = {
      ...params,
      identityBytes,
      failedAttempts: 0,
      queuedSettlement: this.options.captureAttempt?.(params.context),
    };
    this.intents.set(key, intent);
    this.retainedIdentityBytes += identityBytes;
    this.pendingKeys.add(key);
    this.pump();
  }

  retry(params: { agentId: string; voiceSessionId: string }): void {
    const key = operationKey(params.agentId, params.voiceSessionId);
    const intent = this.intents.get(key);
    if (!intent || intent.retryBlocked) {
      return;
    }
    intent.queuedSettlement ??= this.options.captureAttempt?.(intent.context);
    (this.activeAttempts.has(key) ? this.retryAfterActiveKeys : this.pendingKeys).add(key);
    this.pump();
  }

  retryAgent(agentId: string, context: TContext): void {
    try {
      for (const [key, intent] of this.intents) {
        if (
          intent.agentId !== agentId ||
          intent.retryBlocked ||
          this.options.matchesRetryContext?.(intent.context, context) === false
        ) {
          continue;
        }
        intent.context = this.options.updateContext?.(intent.context, context) ?? context;
        intent.queuedSettlement ??= this.options.captureAttempt?.(intent.context);
        (this.activeAttempts.has(key) ? this.retryAfterActiveKeys : this.pendingKeys).add(key);
      }
    } finally {
      this.pump();
    }
  }

  snapshot(): {
    active: number;
    pending: number;
    retained: number;
    retainedIdentityBytes: number;
  } {
    return {
      active: this.activeAttempts.size,
      pending: this.pendingKeys.size,
      retained: this.intents.size,
      retainedIdentityBytes: this.retainedIdentityBytes,
    };
  }

  clear(): void {
    for (const attempt of this.activeAttempts.values()) {
      attempt.abort(new Error("voice mutation digest delivery owner reset"));
    }
    for (const intent of this.intents.values()) {
      intent.queuedSettlement?.release();
      if (intent.failureExpiry) {
        clearTimeout(intent.failureExpiry);
      }
    }
    this.intents.clear();
    this.pendingKeys.clear();
    this.retryAfterActiveKeys.clear();
    this.activeAttempts.clear();
    this.retainedIdentityBytes = 0;
  }

  private deleteIntent(key: string, expected?: MutationDigestIntent<TContext>): void {
    const current = this.intents.get(key);
    if (!current || (expected && current !== expected)) {
      return;
    }
    this.intents.delete(key);
    current.queuedSettlement?.release();
    this.pendingKeys.delete(key);
    this.retryAfterActiveKeys.delete(key);
    if (current.failureExpiry) {
      clearTimeout(current.failureExpiry);
    }
    this.retainedIdentityBytes -= current.identityBytes;
  }

  private blockRetry(key: string, intent: MutationDigestIntent<TContext>): void {
    intent.retryBlocked = true;
    this.clearFailureState(intent);
    this.pendingKeys.delete(key);
    this.retryAfterActiveKeys.delete(key);
    intent.queuedSettlement?.release();
    delete intent.queuedSettlement;
  }

  private stopAfterFailure(
    key: string,
    intent: MutationDigestIntent<TContext>,
    reason: string,
  ): void {
    const delivered = this.options.deliveryState?.(intent.context) === "confirmed";
    if (delivered) {
      this.blockRetry(key, intent);
    } else {
      this.deleteIntent(key, intent);
    }
    this.options.warn(
      `voice mutation digest ${delivered ? "marker retry stopped" : "dropped"} ${reason}`,
    );
  }

  private retainAfterFailure(key: string, intent: MutationDigestIntent<TContext>): void {
    if (intent.failureExpiry) {
      return;
    }
    intent.failureExpiry = setTimeout(() => {
      if (this.intents.get(key) !== intent) {
        return;
      }
      if (this.activeAttempts.has(key)) {
        intent.expireAfterActive = true;
        return;
      }
      this.stopAfterFailure(
        key,
        intent,
        `after retry retention expired (${intent.failedAttempts} failed attempts)`,
      );
    }, this.policy.failureRetentionMs);
    intent.failureExpiry.unref?.();
  }

  private clearFailureState(intent: MutationDigestIntent<TContext>): void {
    if (intent.failureExpiry) {
      clearTimeout(intent.failureExpiry);
      delete intent.failureExpiry;
    }
    delete intent.expireAfterActive;
    intent.failedAttempts = 0;
  }

  private pump(): void {
    while (
      this.activeAttempts.size < this.policy.maxConcurrentAttempts &&
      this.pendingKeys.size > 0
    ) {
      const key = this.pendingKeys.values().next().value as string | undefined;
      if (!key) {
        return;
      }
      this.pendingKeys.delete(key);
      const intent = this.intents.get(key);
      if (!intent || this.activeAttempts.has(key)) {
        continue;
      }
      this.startAttempt(key, intent);
    }
  }

  private startAttempt(key: string, intent: MutationDigestIntent<TContext>): void {
    void runInDetachedAsyncContext(async () => {
      const settlement = intent.queuedSettlement;
      delete intent.queuedSettlement;
      const attempt = new AbortController();
      this.activeAttempts.set(key, attempt);
      const timeout = setTimeout(
        () => attempt.abort(new Error("voice mutation digest delivery abort requested")),
        this.policy.attemptAbortAfterMs,
      );
      timeout.unref?.();
      // Abort is cooperative, not a wall-clock completion guarantee. An adapter
      // that ignores it keeps this exact slot so repeated retries cannot fan out.
      try {
        const run = () => this.options.attempt({ ...intent, signal: attempt.signal });
        const complete = await (settlement ? settlement.run(run) : run());
        if (complete) {
          this.deleteIntent(key, intent);
        } else {
          // A live consult is a defer; its completion event owns the next retry.
          this.clearFailureState(intent);
        }
      } catch (error) {
        if (this.activeAttempts.get(key) !== attempt) {
          return;
        }
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          this.blockRetry(key, intent);
          this.options.warn(
            "voice mutation digest settlement is unknown; delivery was not replayed",
          );
          return;
        }
        if (this.options.deliveryState?.(intent.context) === "uncertain") {
          this.blockRetry(key, intent);
          this.options.warn(
            "voice mutation digest may have been delivered; delivery was not replayed",
          );
          return;
        }
        intent.failedAttempts += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (intent.failedAttempts >= this.policy.maxAttemptFailures) {
          this.stopAfterFailure(
            key,
            intent,
            `after ${intent.failedAttempts} failed attempts: ${message}`,
          );
          return;
        }
        this.options.warn(message);
        this.retainAfterFailure(key, intent);
      } finally {
        settlement?.release();
        clearTimeout(timeout);
        if (this.activeAttempts.get(key) === attempt) {
          this.activeAttempts.delete(key);
          if (intent.expireAfterActive && this.intents.get(key) === intent) {
            this.stopAfterFailure(
              key,
              intent,
              `after retry retention expired (${intent.failedAttempts} failed attempts)`,
            );
          } else if (this.retryAfterActiveKeys.delete(key) && this.intents.has(key)) {
            this.pendingKeys.add(key);
          }
          this.pump();
        }
      }
    });
  }
}

type MutationDigestContext = {
  config: OpenClawConfig;
  source: ClientVoiceSessionSource;
  delivery?: MutationDigestDelivery;
  conversation?: MutationDigestConversation;
};

function sameMutationDigestSource(previous: MutationDigestContext, next: MutationDigestContext) {
  return (
    previous.source.options.path === next.source.options.path &&
    previous.source.identity.key === next.source.identity.key &&
    previous.source.identity.birthtime === next.source.identity.birthtime
  );
}

export function createClientVoiceMutationDigestDeliveryOptions(
  readLiveConsultRuns: () => ReadonlyMap<
    string,
    {
      binding: Pick<ClientVoiceRunBinding, "agentId" | "voiceSessionId">;
      source: Pick<ClientVoiceSessionSource, "identity">;
    }
  >,
  captureAttempt: (
    source?: ClientVoiceSessionSource["settlementContext"],
  ) => MutationDigestSettlement,
): MutationDigestOptions<MutationDigestContext> {
  const hasLiveConsultRun = (
    record: Pick<ClientVoiceRunBinding, "agentId" | "voiceSessionId"> &
      Partial<Pick<ClientVoiceSessionRecord, "consultRunIds">>,
    source: ClientVoiceSessionSource,
  ) =>
    [...readLiveConsultRuns()].some(
      ([runId, { binding, source: runSource }]) =>
        binding.agentId === record.agentId &&
        binding.voiceSessionId === record.voiceSessionId &&
        runSource.identity.key === source.identity.key &&
        runSource.identity.birthtime === source.identity.birthtime &&
        (source.identity.key.startsWith("file:") ||
          runSource.identity.canonicalPath === source.identity.canonicalPath) &&
        (record.consultRunIds === undefined || record.consultRunIds.includes(runId)),
    );

  return {
    captureAttempt: (context) => {
      if (!context.conversation) {
        const storePath = resolveSessionStorePathForScope(
          { agentId: context.source.options.agentId, env: context.source.options.env },
          context.config,
        );
        // Capture configured conversation files before a delivery slot or consult can defer work.
        context.conversation = {
          storePath,
          identities: captureSessionStoreCandidateIdentities(
            captureSessionStoreReadCandidates(storePath),
          ),
        };
      }
      return captureAttempt(context.source.settlementContext);
    },
    // The same file can reopen under a different shared-state admission.
    matchesRetryContext: (previous, next) =>
      sameMutationDigestSource(previous, next) &&
      previous.source.settlementContext.admission === next.source.settlementContext.admission,
    deliveryState: ({ delivery }) =>
      delivery?.confirmed !== undefined
        ? "confirmed"
        : delivery?.mayHaveReachedRecipient
          ? "uncertain"
          : "unsent",
    updateContext(previous, next) {
      if (!sameMutationDigestSource(previous, next)) {
        throw new Error("Voice mutation digest cannot change its accepted physical source");
      }
      previous.source.assertCurrent();
      return {
        config: next.config,
        source: previous.source,
        conversation: previous.conversation,
        ...(previous.delivery ? { delivery: previous.delivery } : {}),
      };
    },
    attempt: async ({ voiceSessionId, context, signal }) => {
      const { config, source } = context;
      source.assertCurrent();
      if (
        !context.delivery?.confirmed &&
        hasLiveConsultRun({ agentId: source.options.agentId, voiceSessionId }, source)
      ) {
        return false;
      }
      const delivery = (context.delivery ??= {});
      const writer = captureClientVoiceSessionWriter({
        agentId: source.options.agentId,
        physicalSource: source,
      });
      return withClientVoiceSessionResources([writer], async () => {
        if (delivery.confirmed) {
          await writer.mutate({
            ...delivery.confirmed,
            kind: "delivered",
            now: Date.now(),
          });
          return true;
        }
        const prepared = await writer.read(voiceSessionId);
        const record = prepared?.record;
        if (!record) {
          return true;
        }
        if (record.status !== "closed" || hasLiveConsultRun(record, source)) {
          return false;
        }
        const conversation = context.conversation;
        if (!conversation) {
          throw new Error("Voice mutation digest conversation source was not captured");
        }
        await deliverClientVoiceMutationDigest(
          record,
          config,
          signal,
          writer,
          delivery,
          prepared?.entry,
          conversation,
        );
        return true;
      });
    },
    warn: (message) => console.warn(`[talk] deferred voice mutation digest failed: ${message}`),
  };
}
