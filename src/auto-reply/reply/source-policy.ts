import type { CanonicalInboundMessageHookContext } from "../../hooks/message-hook-mappers.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookSourcePolicyContext,
  PluginHookSourcePolicyEvent,
  PluginHookSourcePolicyResult,
} from "../../plugins/hook-types.js";
import type { SourcePromptPolicy, SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  resolveHarnessSourceVisibleRepliesDefault,
  resolveTurnModelOverride,
} from "./dispatch-from-config.harness-defaults.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { isExplicitSourceReplyCommand } from "./source-reply-delivery-mode.js";

type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

/** Remove per-message thinking directives before submission or persistence. */
export function stripPromptThinkingDirectives(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/(^|\s)\/(?:thinking|think|t)(?=$|\s|:)(?:\s*:\s*|\s+)?[A-Za-z-]*/gi, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n");
}

/** Resolve model-visible and transcript-visible bodies for source prompt policy. */
export function resolveSourcePromptInput(
  policy: SourcePromptPolicy | undefined,
  transcriptBody: string,
) {
  const configuredBody = policy?.promptBody;
  const promptBody =
    typeof configuredBody === "string" && configuredBody.trim() ? configuredBody.trim() : undefined;
  const promptContextOverrides =
    policy?.suppressConversationContext === true
      ? { currentInboundContext: null }
      : policy && Object.hasOwn(policy, "currentInboundContext")
        ? { currentInboundContext: policy.currentInboundContext ?? null }
        : {};
  return {
    body: promptBody ?? transcriptBody,
    transcriptBody: promptBody === undefined ? undefined : transcriptBody,
    promptContextOverrides,
  };
}

type SourcePolicyResolution = {
  chatType: ReturnType<typeof normalizeChatType>;
  deliveryMode?: SourceReplyDeliveryMode;
  harnessDefaultVisibleReplies?: HarnessSourceVisibleRepliesDefault;
  prefersMessageToolDelivery: boolean;
  promptPolicy?: SourcePromptPolicy;
};

/** Run source policy and translate its restrictive result to reply options. */
export async function resolveSourcePolicy(params: {
  cfg: OpenClawConfig;
  hookContext: CanonicalInboundMessageHookContext;
  inboundClaimContext: PluginHookInboundClaimContext;
  ctx: FinalizedMsgContext;
  sessionKey?: string;
  acpDispatchSessionKey?: string;
  sessionAgentId: string;
  sessionStoreEntry: {
    entry?: SessionEntry;
    sessionKey?: string;
    store?: Record<string, SessionEntry>;
  };
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  sendPolicy: "allow" | "deny";
  isInternalWebchatTurn: boolean;
  abortSignal?: AbortSignal;
  hookRunner?: {
    hasHooks(hookName: "source_policy"): boolean;
    runSourcePolicy(
      event: PluginHookSourcePolicyEvent,
      context: PluginHookSourcePolicyContext,
    ): Promise<PluginHookSourcePolicyResult | undefined>;
  };
  traceReplyPhase<T>(phase: string, run: () => Promise<T>): Promise<T>;
}): Promise<SourcePolicyResolution> {
  const chatType = normalizeChatType(params.ctx.ChatType);
  const configuredVisibleReplies =
    chatType === "group" || chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  const harnessDefaultVisibleReplies =
    configuredVisibleReplies === undefined && chatType !== "group" && chatType !== "channel"
      ? resolveHarnessSourceVisibleRepliesDefault({
          cfg: params.cfg,
          ctx: params.ctx,
          entry: params.sessionStoreEntry.entry,
          sessionAgentId: params.sessionAgentId,
          sessionKey: params.acpDispatchSessionKey,
          sessionStore: params.sessionStoreEntry.store,
          turnModelOverride: resolveTurnModelOverride(params.replyOptions),
        })
      : undefined;
  const event: PluginHookSourcePolicyEvent = {
    content: params.hookContext.content,
    body: params.hookContext.bodyForAgent ?? params.hookContext.body,
    channel: params.hookContext.channelId,
    accountId: params.hookContext.accountId,
    conversationId: params.inboundClaimContext.conversationId,
    sessionKey: params.sessionKey,
    runId: params.replyOptions?.runId,
    senderId: params.hookContext.senderId,
    replyToId: params.hookContext.replyToId,
    replyToBody: params.hookContext.replyToBody,
    replyToSender: params.hookContext.replyToSender,
    isGroup: params.hookContext.isGroup,
    chatType: params.ctx.ChatType,
    inboundEventKind: params.ctx.InboundEventKind,
    requestedSourceReplyDeliveryMode: params.replyOptions?.sourceReplyDeliveryMode,
    configuredVisibleReplies,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
    sendPolicy: params.sendPolicy,
  };
  const context: PluginHookSourcePolicyContext = {
    channelId: params.hookContext.channelId,
    accountId: params.hookContext.accountId,
    conversationId: params.inboundClaimContext.conversationId,
    sessionKey: params.sessionKey,
    runId: params.replyOptions?.runId,
    senderId: params.hookContext.senderId,
    replyToId: params.hookContext.replyToId,
    replyToBody: params.hookContext.replyToBody,
    replyToSender: params.hookContext.replyToSender,
  };
  const result = params.hookRunner?.hasHooks("source_policy")
    ? await params.traceReplyPhase("reply.source_policy_hooks", () =>
        runWithDispatchAbortSignal(params.abortSignal, () =>
          params.hookRunner!.runSourcePolicy(event, context),
        ),
      )
    : undefined;
  const deliveryMode =
    result?.sourceReplyDeliveryMode === "message_tool_only"
      ? "message_tool_only"
      : params.replyOptions?.sourceReplyDeliveryMode;
  const hasPromptPolicy =
    result?.promptBody !== undefined ||
    result?.currentInboundContext !== undefined ||
    result?.suppressConversationContext === true;
  const promptPolicy = hasPromptPolicy
    ? {
        ...(result?.promptBody !== undefined ? { promptBody: result.promptBody } : {}),
        ...(result?.currentInboundContext !== undefined
          ? { currentInboundContext: result.currentInboundContext }
          : {}),
        ...(result?.suppressConversationContext === true
          ? { suppressConversationContext: true as const }
          : {}),
      }
    : params.replyOptions?.sourcePromptPolicy;
  const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
  return {
    chatType,
    deliveryMode,
    harnessDefaultVisibleReplies,
    prefersMessageToolDelivery:
      deliveryMode === "message_tool_only" ||
      (params.ctx.InboundEventKind === "room_event" && !params.isInternalWebchatTurn) ||
      (deliveryMode === undefined &&
        !isExplicitSourceReplyCommand(params.ctx, params.cfg) &&
        (configuredVisibleReplies === "message_tool" ||
          (!params.isInternalWebchatTurn && effectiveVisibleReplies === "message_tool"))),
    promptPolicy,
  };
}
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
