/** Formatting, retry, and idempotency policy for direct cron delivery. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../auto-reply/tokens.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { isSuppressedControlReplyText } from "../../gateway/control-reply-text.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  captureDeliveryQueueStateContext,
  inspectDeliveryQueueReceipt,
  type DeliveryQueueCompletionRetention,
} from "../../infra/delivery-queue-sqlite.js";
import * as deliveryRecovery from "../../infra/delivery-recovery.shared.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { retryAsync } from "../../infra/retry.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";
import { hasExplicitCronDeliveryTarget } from "../delivery-target-validation.js";
import { createCronExecutionId } from "../run-id.js";
import { hasScheduledNextRunAtMs } from "../service/jobs-scheduling.js";
import type { CronJob } from "../types.js";
import type {
  DispatchCronDeliveryParams,
  SuccessfulCronDeliveryTarget,
} from "./delivery-dispatch-types.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

export const DIRECT_CRON_DELIVERY_COMPLETION_RETENTION = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const satisfies DeliveryQueueCompletionRetention;

/** Carry the implicit source's generation through outbound custody and recovery. */
export function resolveDirectCronDeliveryGeneration(
  params: Pick<
    DispatchCronDeliveryParams,
    | "job"
    | "sourceSessionKey"
    | "sourceSessionGeneration"
    | "deliveryPlan"
    | "agentId"
    | "cfgWithAgentDefaults"
  >,
) {
  return (params.job.sessionTarget === "isolated" || params.job.sessionTarget === "current") &&
    params.sourceSessionKey &&
    params.sourceSessionGeneration &&
    !hasExplicitCronDeliveryTarget(params.deliveryPlan)
    ? {
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfgWithAgentDefaults.session?.store, {
          agentId: params.agentId,
        }),
        sessionKey: params.sourceSessionKey,
        sessionId: params.sourceSessionGeneration.sessionId,
        lifecycleRevision: params.sourceSessionGeneration.lifecycleRevision ?? null,
      }
    : undefined;
}

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

type NormalizedSilentReplyText = {
  text: string | undefined;
  strippedTrailingSilentToken: boolean;
};

export function normalizeSilentReplyText(text: string | undefined): NormalizedSilentReplyText {
  if (!text) {
    return { text, strippedTrailingSilentToken: false };
  }
  if (isSuppressedControlReplyText(text)) {
    return { text: undefined, strippedTrailingSilentToken: false };
  }

  let next = text;
  const hasLeadingSilentToken = startsWithSilentToken(next, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    next = stripLeadingSilentToken(next, SILENT_REPLY_TOKEN);
  }

  let strippedTrailingSilentToken = false;
  if (hasLeadingSilentToken || next.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    const trimmedBefore = next.trim();
    const stripped = stripSilentToken(next, SILENT_REPLY_TOKEN);
    strippedTrailingSilentToken = stripped !== trimmedBefore;
    next = stripped;
  }

  if (!next.trim() || isSuppressedControlReplyText(next)) {
    return { text: undefined, strippedTrailingSilentToken };
  }
  return { text: next, strippedTrailingSilentToken };
}

const PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

const STALE_CRON_DELIVERY_MAX_START_DELAY_MS = 3 * 60 * 60_000;

const deliveryLoggerRuntimeLoader = createLazyImportLoader(() => import("../../logger.js"));
const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));
const deliverySubagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-subagent-registry.runtime.js"),
);

const subagentFollowupRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-followup.runtime.js"),
);

/** Descendant-run outcome that decides which text cron delivery finalizes. */
type DescendantSubagentFollowup = {
  /** Descendant reply that replaces the interim cron text; undefined keeps the original. */
  finalReply: string | undefined;
  hasUnsettledDescendants: boolean;
  hadDescendants: boolean;
};

/** Resolves whether descendant subagent output should replace the interim cron text. */
export async function resolveDescendantSubagentFollowup(params: {
  sessionKey: string;
  runStartedAt: number;
  timeoutMs: number;
  deliveryBestEffort: boolean;
  spawnOnlyHandoff: boolean;
  initialSynthesizedText: string;
  abortSignal?: AbortSignal;
}): Promise<DescendantSubagentFollowup> {
  const expectedFollowup = expectsSubagentFollowup(params.initialSynthesizedText);
  const subagentRegistryRuntime = await deliverySubagentRegistryRuntimeLoader.load();
  let hasUnsettledDescendants = await subagentRegistryRuntime.hasUnsettledCronDescendants(
    params.sessionKey,
  );
  const shouldCheckCompletedDescendants =
    !params.abortSignal?.aborted &&
    !hasUnsettledDescendants &&
    (params.spawnOnlyHandoff || isLikelyInterimCronMessage(params.initialSynthesizedText));
  const needsFollowupRuntime =
    shouldCheckCompletedDescendants || hasUnsettledDescendants || expectedFollowup;
  const followupRuntime = needsFollowupRuntime
    ? await subagentFollowupRuntimeLoader.load()
    : undefined;
  // A child may settle before delivery starts without matching the narrow
  // follow-up hints. Its result still replaces the parent's interim text.
  const completedDescendantReply = shouldCheckCompletedDescendants
    ? await followupRuntime?.readDescendantSubagentFallbackReply({
        sessionKey: params.sessionKey,
        runStartedAt: params.runStartedAt,
      })
    : undefined;
  const hadDescendants = hasUnsettledDescendants || Boolean(completedDescendantReply);
  if (
    (!params.deliveryBestEffort || params.spawnOnlyHandoff) &&
    (hasUnsettledDescendants || expectedFollowup)
  ) {
    let finalReply = await followupRuntime?.waitForDescendantSubagentSummary({
      sessionKey: params.sessionKey,
      initialReply: params.initialSynthesizedText,
      timeoutMs: params.timeoutMs,
      observedActiveDescendants: hasUnsettledDescendants || expectedFollowup,
      abortSignal: params.abortSignal,
    });
    hasUnsettledDescendants = await subagentRegistryRuntime.hasUnsettledCronDescendants(
      params.sessionKey,
    );
    if (!params.abortSignal?.aborted && !finalReply && !hasUnsettledDescendants) {
      finalReply = await followupRuntime?.readDescendantSubagentFallbackReply({
        sessionKey: params.sessionKey,
        runStartedAt: params.runStartedAt,
      });
    }
    // Apply only once every descendant settled; a live run still owns the turn.
    return {
      finalReply: finalReply && !hasUnsettledDescendants ? finalReply : undefined,
      hasUnsettledDescendants,
      hadDescendants,
    };
  }
  return { finalReply: completedDescendantReply, hasUnsettledDescendants, hadDescendants };
}

export async function logCronDeliveryWarn(message: string): Promise<void> {
  const { logWarn } = await deliveryLoggerRuntimeLoader.load();
  logWarn(message);
}

export function resolveStaleCronDeliveryError(params: {
  job: CronJob;
  runStartedAt: number;
}): string | undefined {
  const scheduledAt = params.job.state?.nextRunAtMs;
  const scheduledAtMs = hasScheduledNextRunAtMs(scheduledAt) ? scheduledAt : params.runStartedAt;
  const startDelayMs = params.runStartedAt - scheduledAtMs;
  if (startDelayMs > STALE_CRON_DELIVERY_MAX_START_DELAY_MS) {
    const nowMs = Date.now();
    return `skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 60_000)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 60_000)}m`;
  }
  return undefined;
}

export async function maybeApplyTtsToCronPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  delivery: Pick<SuccessfulCronDeliveryTarget, "channel" | "accountId">;
  agentId: string;
  ttsAuto?: TtsAutoMode;
}): Promise<ReplyPayload[]> {
  const preparedTtsPreferences = await prepareTtsPreferences();
  if (
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      preparedTtsPreferences,
      ttsAuto: params.ttsAuto,
      agentId: params.agentId,
      channelId: params.delivery.channel,
      accountId: params.delivery.accountId,
    })
  ) {
    return params.payloads;
  }
  const { maybeApplyTtsToPayload } = await ttsRuntimeLoader.load();
  return await Promise.all(
    params.payloads.map((payload) =>
      maybeApplyTtsToPayload({
        payload,
        preparedTtsPreferences,
        cfg: params.cfg,
        channel: params.delivery.channel,
        kind: "final",
        ttsAuto: params.ttsAuto,
        agentId: params.agentId,
        accountId: params.delivery.accountId,
      }),
    ),
  );
}

export function buildDirectCronDeliveryIdempotencyKey(params: {
  jobId: string;
  runStartedAt: number;
  delivery: Pick<SuccessfulCronDeliveryTarget, "channel" | "to" | "accountId" | "threadId">;
}): string {
  // Include route identity, not just the cron execution id, because one run can
  // target different channels/accounts/threads across retry and fallback paths.
  const executionId = createCronExecutionId(params.jobId, params.runStartedAt);
  const threadId =
    params.delivery.threadId == null || params.delivery.threadId === ""
      ? ""
      : (stringifyRouteThreadId(params.delivery.threadId) ?? "");
  const accountId = params.delivery.accountId?.trim() ?? "";
  const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
  // Escape route fields independently so colon-bearing identities cannot
  // collide while ordinary shipped channel and target keys stay unchanged.
  const routeIdentity = [params.delivery.channel, accountId, normalizedTo, threadId]
    .map(encodeURIComponent)
    .join(":");
  return `${DIRECT_CRON_DELIVERY_COMPLETION_RETENTION.idPrefix}${executionId}:${routeIdentity}`;
}

/** Receipts own recipient delivery; projections never stand in for custody. */
export async function isCompletedDirectCronDelivery(
  id: string,
  queueName: string,
): Promise<boolean> {
  const context = captureDeliveryQueueStateContext();
  const receipt = await inspectDeliveryQueueReceipt(queueName, id, false, context);
  return receipt.status === "completed";
}

/** Wait only for an active recipient owner, never for crashed ambiguous sends. */
export async function waitForCompletedDirectCronDelivery(params: {
  id: string;
  queueName: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const context = captureDeliveryQueueStateContext();
  // SQLite producer leases fence cross-process sends for at most 30 seconds.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    params.signal?.throwIfAborted();
    const { status, pendingEntry: owner } = await inspectDeliveryQueueReceipt(
      params.queueName,
      params.id,
      true,
      context,
    );
    params.signal?.throwIfAborted();
    if (status === "completed") {
      return true;
    }
    if (
      !owner ||
      (owner.recoveryState === "send_attempt_started"
        ? typeof owner.platformSendStartedAt !== "number" ||
          owner.platformSendStartedAt <= Date.now() - 30_000
        : owner.recoveryState !== "producer_claimed" ||
          typeof owner.availableAt !== "number" ||
          owner.availableAt <= Date.now())
    ) {
      return false;
    }
    if (attempt < 119) {
      await sleepWithAbort(250, params.signal);
    }
  }
  return false;
}

function summarizeDirectCronDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function isTransientDirectCronDeliveryError(error: unknown): boolean {
  const typedRetryability = deliveryRecovery.resolveDeliveryNotSentRetryability(error);
  if (typedRetryability !== undefined) {
    return typedRetryability;
  }
  const message = summarizeDirectCronDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return deliveryRecovery.isProvenDeliveryNotSentError(error);
}
export async function retryTransientDirectCronDelivery<T>(params: {
  jobId: string;
  label?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  run: () => Promise<T>;
  shouldRetryError?: (err: unknown) => boolean;
}): Promise<T> {
  const retryDelaysMs = isFastTestRuntimeEnv() ? [0, 0, 0] : [5_000, 10_000, 20_000];
  const assertActive = () => {
    if (params.signal?.aborted) {
      throw new Error("cron delivery aborted");
    }
    if (params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs) {
      const error = new Error("cron delivery deadline exceeded");
      error.name = "TimeoutError";
      throw error;
    }
  };
  assertActive();
  const runWithAbortCheck = async () => {
    assertActive();
    return await params.run();
  };
  return await retryAsync(runWithAbortCheck, {
    attempts: retryDelaysMs.length + 1,
    minDelayMs: 0,
    maxDelayMs: Math.max(...retryDelaysMs),
    delayMs: ({ attempt }) => retryDelaysMs[attempt - 1] ?? 0,
    shouldRetry: (err) =>
      params.signal?.aborted !== true &&
      (params.deadlineAtMs === undefined || Date.now() < params.deadlineAtMs) &&
      isTransientDirectCronDeliveryError(err) &&
      (params.shouldRetryError?.(err) ?? true),
    onRetry: async ({ attempt, maxAttempts, delayMs, err }) => {
      await logCronDeliveryWarn(
        `[cron:${params.jobId}] transient ${params.label ?? "direct announce"} delivery failure, retrying ${attempt + 1}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDirectCronDeliveryError(err)}`,
      );
      if (delayMs === 0) {
        await sleepWithAbort(0, params.signal);
      }
    },
    sleep: async (delayMs) => {
      const remainingMs =
        params.deadlineAtMs === undefined ? delayMs : Math.max(0, params.deadlineAtMs - Date.now());
      await sleepWithAbort(Math.min(delayMs, remainingMs), params.signal);
      assertActive();
    },
  });
}
