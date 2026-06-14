// Source reply mirroring records successful same-conversation message-tool
// sends back into the owning session transcript.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForMirror } from "./payloads.js";

type SourceReplyTranscriptMirrorParams = {
  action: string;
  channel: string;
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  toolContext?: ChannelThreadingToolContext;
  idempotencyKey?: string;
  deliveredPayload?: unknown;
};

type MirrorableSourceReplyTranscriptParams = SourceReplyTranscriptMirrorParams & {
  sessionKey: string;
};

type SourceReplyThreadPlacement = "match" | "mismatch" | "unknown";

// Mirror only enough delivered payload detail to preserve transcript context.
function readStringArray(value: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFirstString(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(params[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveSourceReplyTarget(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["target", "to", "channelId", "chatId"]);
}

function resolveSourceReplyThreadId(params: SourceReplyTranscriptMirrorParams): string | undefined {
  return readFirstString(params.actionParams, ["threadId", "messageThreadId"]);
}

function resolveDeliveredThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
  currentThreadId: string | undefined,
): SourceReplyThreadPlacement | undefined {
  const payload = asRecord(params.deliveredPayload);
  const result = asRecord(payload?.result);
  const receipt = asRecord(result?.receipt) ?? asRecord(payload?.receipt);
  if (!receipt) {
    return undefined;
  }
  const deliveredThreadId = normalizeOptionalString(receipt.threadId);
  return deliveredThreadId
    ? deliveredThreadId === currentThreadId
      ? "match"
      : "mismatch"
    : currentThreadId
      ? "mismatch"
      : "match";
}

function resolveSourceReplyThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
): SourceReplyThreadPlacement {
  const currentThreadId = normalizeOptionalString(params.toolContext?.currentThreadTs);
  const deliveredPlacement = resolveDeliveredThreadPlacement(params, currentThreadId);
  if (deliveredPlacement) {
    return deliveredPlacement;
  }
  if (params.actionParams.topLevel === true) {
    return currentThreadId ? "mismatch" : "match";
  }
  for (const key of ["threadId", "messageThreadId"] as const) {
    if (!Object.hasOwn(params.actionParams, key)) {
      continue;
    }
    const explicitThreadId = normalizeOptionalString(params.actionParams[key]);
    if (!explicitThreadId) {
      return currentThreadId ? "mismatch" : "match";
    }
    return explicitThreadId === currentThreadId ? "match" : "mismatch";
  }
  return currentThreadId ? "unknown" : "match";
}

function resolveThreadedSourceTarget(
  params: SourceReplyTranscriptMirrorParams,
  requestedTarget: string,
): string {
  const threadId = resolveSourceReplyThreadId(params);
  if (!threadId) {
    return requestedTarget;
  }
  return (
    normalizeOptionalString(
      getChannelPlugin(params.channel as ChannelId)?.threading?.resolveCurrentChannelId?.({
        to: requestedTarget,
        threadId,
      }),
    ) ?? requestedTarget
  );
}

function hasExplicitDeliveryFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    return true;
  }
  const status = normalizeOptionalLowercaseString(record.status);
  if (status === "failed" || status === "error") {
    return true;
  }
  const deliveryStatus = normalizeOptionalLowercaseString(record.deliveryStatus);
  return deliveryStatus === "failed" || deliveryStatus === "error";
}

function isCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
): params is MirrorableSourceReplyTranscriptParams {
  if (params.action !== "send") {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return false;
  }
  const toolContext = params.toolContext;
  if (!toolContext) {
    return false;
  }
  const currentChannel = normalizeOptionalLowercaseString(toolContext.currentChannelProvider);
  if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) {
    return false;
  }
  const currentTargets = [
    normalizeOptionalString(toolContext.currentMessagingTarget),
    normalizeOptionalString(toolContext.currentChannelId),
  ].filter((target): target is string => Boolean(target));
  if (currentTargets.length === 0) {
    return false;
  }
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (!requestedTarget) {
    return false;
  }
  const threadPlacement = resolveSourceReplyThreadPlacement(params);
  if (threadPlacement === "mismatch") {
    return false;
  }
  const threadedTarget = resolveThreadedSourceTarget(params, requestedTarget);
  const matchesToolContextTarget = getChannelPlugin(params.channel as ChannelId)?.threading
    ?.matchesToolContextTarget;
  if (
    threadPlacement === "match" &&
    (matchesToolContextTarget?.({
      target: requestedTarget,
      toolContext,
    }) ||
      (threadedTarget !== requestedTarget &&
        matchesToolContextTarget?.({
          target: threadedTarget,
          toolContext,
        })))
  ) {
    return true;
  }
  return currentTargets.some(
    (currentTarget) => requestedTarget === currentTarget || threadedTarget === currentTarget,
  );
}

/** Mirrors successful outbound source replies into the owning session transcript. */
export async function mirrorDeliveredSourceReplyToTranscript(
  params: SourceReplyTranscriptMirrorParams,
): Promise<boolean> {
  if (hasExplicitDeliveryFailure(params.deliveredPayload)) {
    return false;
  }
  if (!isCurrentSourceConversation(params)) {
    return false;
  }

  const plan = createOutboundPayloadPlan([
    {
      text: readFirstString(params.actionParams, ["message", "content", "text", "caption"]) ?? "",
      mediaUrl: readFirstString(params.actionParams, [
        "mediaUrl",
        "media",
        "path",
        "filePath",
        "fileUrl",
      ]),
      mediaUrls: readStringArray(params.actionParams.mediaUrls),
      presentation: params.actionParams.presentation as ReplyPayload["presentation"],
      interactive: params.actionParams.interactive as ReplyPayload["interactive"],
      channelData: params.actionParams.channelData as ReplyPayload["channelData"],
    },
  ]);
  const mirror = projectOutboundPayloadPlanForMirror(plan);
  if (!mirror.text && mirror.mediaUrls.length === 0) {
    return false;
  }

  await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    text: mirror.text,
    mediaUrls: mirror.mediaUrls.length ? mirror.mediaUrls : undefined,
    idempotencyKey: params.idempotencyKey,
    config: params.cfg,
  });
  return true;
}
