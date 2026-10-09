import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { NormalizedOutboundPayload } from "../../infra/outbound/deliver.js";
import type { OutboundSessionRoute } from "../../infra/outbound/outbound-session.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryVisibleDelivery,
} from "../../infra/outbound/source-delivery-plan.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { parseThreadSessionSuffix } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { CRON_DIRECT_DELIVERY_CONTEXT_KIND } from "../../shared/transcript-only-openclaw-assistant.js";
import type { CronJob } from "../types.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  logCronDeliveryWarn,
  normalizeDeliveryTarget,
} from "./delivery-dispatch-policy.js";
import type { SuccessfulCronDeliveryTarget } from "./delivery-dispatch-types.js";
import { selectCronRouteCurrentSessionKey } from "./delivery-route-session-key.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickLastNonEmptyTextFromPayloads } from "./helpers.js";
import { resolveCronLifecycleRevisionIdentity } from "./run-session-state.js";
import { loadCronSessionEntryLatest } from "./session.js";

export type DirectCronTranscriptMirror = {
  sessionKey: string;
  agentId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  text?: string;
  mediaUrls?: string[];
  storePath?: string;
  idempotencyKey: string;
  deliveryMirror?: { kind: typeof CRON_DIRECT_DELIVERY_CONTEXT_KIND };
  config: OpenClawConfig;
};

const deliveryOutboundRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-outbound.runtime.js"),
);
const outboundSessionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/outbound-session.js"),
);
const transcriptRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/transcript.runtime.js"),
);
export function shouldQueueCronAwareness(params: {
  job: CronJob;
  delivery: SuccessfulCronDeliveryTarget;
  deliveryBestEffort: boolean;
}): boolean {
  // Keep issue #52136 scoped to isolated runs with an explicit delivery target.
  // Default isolated announce delivery must not mirror text into the main session.
  return (
    params.job.sessionTarget === "isolated" &&
    !params.deliveryBestEffort &&
    params.delivery.mode === "explicit"
  );
}

export function resolveCronAwarenessMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return params.cfg.session?.scope === "global"
    ? "global"
    : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
}

export function isSameSessionKey(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return normalizedLeft != null && normalizedLeft === normalizedRight;
}

export function resolveCronAwarenessText(params: {
  deliveryPayloads: ReplyPayload[];
  outboundPayloads: NormalizedOutboundPayload[];
}): string | undefined {
  if (params.outboundPayloads.length) {
    const projection = projectDeliveredDirectCronPayloadsForMirror(params.outboundPayloads);
    const projectedText = resolveDirectCronTranscriptMirrorText(projection);
    if (projectedText) {
      return projectedText;
    }
  }
  return pickLastNonEmptyTextFromPayloads(params.deliveryPayloads);
}

export function formatTargetCronDeliveryFailureAwarenessText(params: {
  job: CronJob;
  channel: string;
  to: string;
  threadId?: string;
  partialDelivered?: boolean;
}): string {
  const targetParts = [`${params.channel}:${params.to}`];
  if (params.threadId) {
    targetParts.push(`thread ${params.threadId}`);
  }
  return [
    "A scheduled automation attempted to deliver to this channel, but delivery failed.",
    `Job: ${params.job.name || params.job.id}`,
    `Target: ${targetParts.join(" ")}`,
    "Check automation history for delivery error details.",
    params.partialDelivered
      ? "One or more scheduled message payloads may already have been delivered."
      : "No scheduled message was delivered.",
  ].join("\n");
}

export async function queueCronAwarenessSystemEvent(params: {
  cfg: OpenClawConfig;
  jobId: string;
  agentId: string;
  deliveryIdempotencyKey: string;
  queueMainSession: boolean;
  targetSessionKey?: string;
  text: string;
  targetText?: string;
}): Promise<void> {
  try {
    const { enqueueSystemEvent } = await deliveryOutboundRuntimeLoader.load();
    const mainSessionKey = resolveCronAwarenessMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    if (params.queueMainSession) {
      enqueueSystemEvent(
        params.text,
        withSystemEventOwner(
          { sessionKey: mainSessionKey, contextKey: params.deliveryIdempotencyKey },
          params.agentId,
        ),
      );
    }
    const targetSessionKey = params.targetSessionKey;
    const shouldQueueTargetSession =
      targetSessionKey &&
      (!isSameSessionKey(targetSessionKey, mainSessionKey) || !params.queueMainSession);
    if (shouldQueueTargetSession) {
      const text =
        params.targetText ??
        `A scheduled automation delivered this message to this channel:\n${params.text}`;
      const options = withSystemEventOwner(
        { sessionKey: targetSessionKey, contextKey: params.deliveryIdempotencyKey },
        params.agentId,
      );
      enqueueSystemEvent(text, options);
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.jobId}] failed to queue isolated cron awareness: ${formatErrorMessage(err)}`,
    );
  }
}

export function buildDirectCronTranscriptMirrorPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return payloads.map((payload) => {
    const spokenText = normalizeOptionalString(payload.spokenText);
    if (!spokenText) {
      return payload;
    }
    // For TTS auto payloads the spoken text is the transcript content; keep
    // non-audio media only so mirrors do not show generated voice files twice.
    const mediaUrls = [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
      (url): url is string => Boolean(url) && !isAudioFileName(url),
    );
    const {
      mediaUrl: _mediaUrl,
      mediaUrls: _mediaUrls,
      audioAsVoice: _audioAsVoice,
      spokenText: _spokenText,
      ...rest
    } = payload;
    return copyReplyPayloadMetadata(payload, {
      ...rest,
      text: spokenText,
      ...(mediaUrls.length ? { mediaUrls } : {}),
    });
  });
}

export function resolveDirectCronTranscriptMirrorText(params: {
  text?: string;
  mediaUrls: string[];
}): string | undefined {
  const text = normalizeOptionalString(params.text);
  const mediaText = resolveMirroredTranscriptText({ mediaUrls: params.mediaUrls }) ?? undefined;
  if (text && mediaText) {
    return `${text}\n${mediaText}`;
  }
  return text ?? mediaText;
}

export function projectDeliveredDirectCronPayloadsForMirror(
  payloads: readonly NormalizedOutboundPayload[],
): { text?: string; mediaUrls: string[] } {
  const textParts: string[] = [];
  const mediaUrls: string[] = [];
  for (const payload of payloads) {
    const text =
      normalizeOptionalString(payload.hookContent) ?? normalizeOptionalString(payload.text);
    if (text) {
      textParts.push(text);
    }
    for (const mediaUrl of payload.mediaUrls) {
      if (
        (payload.audioAsVoice === true || Boolean(payload.hookContent)) &&
        isAudioFileName(mediaUrl)
      ) {
        continue;
      }
      mediaUrls.push(mediaUrl);
    }
  }
  return {
    text: textParts.join("\n"),
    mediaUrls,
  };
}

function canonicalizeDirectCronRouteSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  const sessionKey = params.sessionKey.trim();
  const canonical = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey,
  });
  if (canonical !== sessionKey) {
    return canonical;
  }
  const thread = parseThreadSessionSuffix(sessionKey);
  if (!thread.baseSessionKey || !thread.threadId) {
    return sessionKey;
  }
  const canonicalBase = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: thread.baseSessionKey,
  });
  if (canonicalBase === thread.baseSessionKey || canonicalBase === "global") {
    return sessionKey;
  }
  return `${canonicalBase}:thread:${thread.threadId}`;
}

// Resolves the outbound session route for a concrete visible delivery target.
// Does NOT persist the route — the caller must commit it after successful
// platform delivery, matching the post-success invariant in message-action-send
// and gateway server-methods/send.
export async function resolveCronDeliveryRouteSessionKey(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  delivery: SuccessfulCronDeliveryTarget;
  warningContext: string;
}): Promise<{ sessionKey: string; route: OutboundSessionRoute | null }> {
  try {
    const { resolveOutboundSessionRoute } = await outboundSessionRuntimeLoader.load();
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.delivery.channel,
      agentId: params.agentId,
      accountId: params.delivery.accountId,
      target: params.delivery.to,
      currentSessionKey: selectCronRouteCurrentSessionKey(
        params.job,
        params.agentSessionKey,
        params.delivery.channel,
        params.delivery.to,
      ),
      threadId: params.delivery.threadId,
    });
    const routeSessionKey = route?.sessionKey?.trim();
    if (!route || !routeSessionKey) {
      return { sessionKey: params.agentSessionKey, route: null };
    }
    const canonicalRouteSessionKey = canonicalizeDirectCronRouteSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: routeSessionKey,
    });
    const canonicalRouteBaseSessionKey = canonicalizeDirectCronRouteSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: route.baseSessionKey,
    });
    const canonicalRoute =
      canonicalRouteSessionKey === route.sessionKey &&
      canonicalRouteBaseSessionKey === route.baseSessionKey
        ? route
        : {
            ...route,
            sessionKey: canonicalRouteSessionKey,
            baseSessionKey: canonicalRouteBaseSessionKey,
          };
    return { sessionKey: canonicalRouteSessionKey, route: canonicalRoute };
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] failed to resolve destination session for ${params.warningContext}: ${formatErrorMessage(err)}`,
    );
    return { sessionKey: params.agentSessionKey, route: null };
  }
}

// Persists the resolved outbound route after successful platform delivery.
// A failed send must not mint a conversation identity or rebind the session
// route — this matches the post-success invariant in message-action-send.ts
// and gateway server-methods/send.ts.
export async function commitDirectCronOutboundRoute(params: {
  cfg: OpenClawConfig;
  runSessionKey?: string;
  delivery: SuccessfulCronDeliveryTarget;
  route: OutboundSessionRoute | null;
}): Promise<void> {
  if (!params.route) {
    return;
  }
  try {
    const { ensureOutboundSessionEntry } = await outboundSessionRuntimeLoader.load();
    await ensureOutboundSessionEntry({
      cfg: params.cfg,
      channel: params.delivery.channel,
      accountId: params.delivery.accountId,
      route: params.route,
      sourceSessionKey: params.runSessionKey,
    });
  } catch (err) {
    // Do not block delivery completion on session meta writes.
    await logCronDeliveryWarn(
      `[cron] failed to persist outbound route after delivery: ${formatErrorMessage(err)}`,
    );
  }
}

function resolveCronMessageToolAwarenessTarget(params: {
  delivery: SourceDeliveryVisibleDelivery;
  resolvedDelivery: DeliveryTargetResolution;
}): (SuccessfulCronDeliveryTarget & { text: string }) | undefined {
  const { target } = params.delivery;
  const text =
    normalizeOptionalString(target.text) ??
    resolveMirroredTranscriptText({ mediaUrls: target.mediaUrls }) ??
    undefined;
  if (!text) {
    return undefined;
  }
  const targetChannel = normalizeOptionalString(target.provider);
  const verifiedTarget =
    params.delivery.verifiedTarget && params.resolvedDelivery.ok
      ? params.resolvedDelivery
      : undefined;
  const channel =
    targetChannel && targetChannel !== "message" ? targetChannel : verifiedTarget?.channel;
  const to = normalizeOptionalString(target.to) ?? verifiedTarget?.to;
  if (!channel || !to) {
    return undefined;
  }
  const accountId = target.accountId ?? verifiedTarget?.accountId;
  const threadId =
    target.threadId ?? (target.threadImplicit === true ? verifiedTarget?.threadId : undefined);
  return {
    ok: true,
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    mode: "explicit",
    text,
  };
}

export async function queueCronMessageToolDeliveryAwareness(params: {
  cfg: OpenClawConfig;
  runSessionKey: string;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  deferredTargetSessionKey?: string;
  runStartedAt: number;
  resolvedDelivery: DeliveryTargetResolution;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
}): Promise<(() => Promise<void>) | undefined> {
  const seen = new Set<string>();
  const deferredAwareness: Array<() => Promise<void>> = [];
  for (const delivery of params.sourceDeliveryOutcome.visibleDeliveries) {
    const target = resolveCronMessageToolAwarenessTarget({
      delivery,
      resolvedDelivery: params.resolvedDelivery,
    });
    if (!target) {
      continue;
    }
    const dedupeKey = [
      target.channel,
      normalizeDeliveryTarget(target.channel, target.to),
      target.accountId ?? "",
      target.threadId ?? "",
      target.text,
    ].join("\0");
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const { sessionKey: targetSessionKey, route: targetRoute } =
      await resolveCronDeliveryRouteSessionKey({
        cfg: params.cfg,
        job: params.job,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        delivery: target,
        warningContext: "message-tool delivery awareness",
      });
    // Awareness runs after the message-tool delivery has already completed,
    // so persisting the route here is post-success.
    await commitDirectCronOutboundRoute({
      cfg: params.cfg,
      runSessionKey: params.runSessionKey,
      delivery: target,
      route: targetRoute,
    });
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery: target,
    });
    const awarenessParams = {
      cfg: params.cfg,
      jobId: params.job.id,
      agentId: params.agentId,
      deliveryIdempotencyKey,
      queueMainSession: false,
      targetSessionKey,
      text: target.text,
    };
    if (isSameSessionKey(targetSessionKey, params.deferredTargetSessionKey)) {
      // A current-session completion owns this target durably. Keep awareness
      // unavailable until that commit fails so reply admission cannot race it.
      deferredAwareness.push(() => queueCronAwarenessSystemEvent(awarenessParams));
      continue;
    }
    await queueCronAwarenessSystemEvent(awarenessParams);
  }
  if (deferredAwareness.length === 0) {
    return undefined;
  }
  return async () => {
    for (const queue of deferredAwareness) {
      await queue();
    }
  };
}

async function appendDirectCronDeliveryTranscriptMirror(params: {
  job: CronJob;
  mirror: DirectCronTranscriptMirror;
}): Promise<void> {
  if (!params.mirror.text && !params.mirror.mediaUrls?.length) {
    return;
  }
  try {
    const { appendAssistantMessageToSessionTranscript } = await transcriptRuntimeLoader.load();
    const result = await appendAssistantMessageToSessionTranscript(params.mirror);
    if (!result.ok) {
      await logCronDeliveryWarn(
        `[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${result.reason}`,
      );
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${formatErrorMessage(err)}`,
    );
  }
}

export async function appendAdmittedDirectCronDeliveryTranscriptMirror(params: {
  job: CronJob;
  mirror: DirectCronTranscriptMirror;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    const storePath = params.mirror.storePath;
    const initial = storePath
      ? await loadCronSessionEntryLatest(storePath, params.mirror.sessionKey)
      : undefined;
    const expectedSessionId = params.mirror.expectedSessionId ?? initial?.sessionId;
    const expectedLifecycleRevision =
      params.mirror.expectedLifecycleRevision ?? initial?.lifecycleRevision;
    if (!storePath || !expectedSessionId) {
      await logCronDeliveryWarn(
        `[cron:${params.job.id}] skipped transcript mirror without an exact session identity`,
      );
      return;
    }
    const admittedMirror = {
      ...params.mirror,
      expectedSessionId,
      ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
    };

    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [
        params.mirror.sessionKey,
        expectedSessionId,
        expectedLifecycleRevision
          ? resolveCronLifecycleRevisionIdentity(expectedLifecycleRevision)
          : undefined,
      ],
      signal: params.abortSignal,
      assertAllowed: async (signal) => {
        const latest = await loadCronSessionEntryLatest(storePath, params.mirror.sessionKey);
        signal.throwIfAborted();
        if (
          latest?.sessionId !== expectedSessionId ||
          (expectedLifecycleRevision !== undefined &&
            latest.lifecycleRevision !== expectedLifecycleRevision)
        ) {
          throw new Error(
            `Session "${params.mirror.sessionKey}" changed before transcript mirror.`,
          );
        }
        const archivedError = resolveSessionWorkStartError(params.mirror.sessionKey, latest, {
          purpose: "accepted-result-settlement",
        });
        if (archivedError) {
          throw new Error(archivedError);
        }
      },
    });
    try {
      await admission.run(() =>
        appendDirectCronDeliveryTranscriptMirror({
          job: params.job,
          mirror: admittedMirror,
        }),
      );
    } finally {
      admission.release();
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] skipped transcript mirror: ${formatErrorMessage(err)}`,
    );
  }
}
