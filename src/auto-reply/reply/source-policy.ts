import type { CanonicalInboundMessageHookContext } from "../../hooks/message-hook-mappers.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookSourcePolicyContext,
  PluginHookSourcePolicyEvent,
  PluginHookSourcePolicyResult,
} from "../../plugins/hook-types.js";
import type { SourcePromptPolicy, SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";

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
  deliveryMode?: SourceReplyDeliveryMode;
  promptPolicy?: SourcePromptPolicy;
};

/** Run source policy and translate its restrictive result to reply options. */
export async function resolveSourcePolicy(params: {
  hookContext: CanonicalInboundMessageHookContext;
  inboundClaimContext: PluginHookInboundClaimContext;
  ctx: FinalizedMsgContext;
  sessionKey?: string;
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  configuredVisibleReplies?: HarnessSourceVisibleRepliesDefault;
  defaultVisibleReplies?: HarnessSourceVisibleRepliesDefault;
  sendPolicy: "allow" | "deny";
  runHook?: (
    event: PluginHookSourcePolicyEvent,
    context: PluginHookSourcePolicyContext,
  ) => Promise<PluginHookSourcePolicyResult | undefined>;
}): Promise<SourcePolicyResolution> {
  const result = await params.runHook?.(
    {
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
      configuredVisibleReplies: params.configuredVisibleReplies,
      defaultVisibleReplies: params.defaultVisibleReplies,
      sendPolicy: params.sendPolicy,
    },
    {
      channelId: params.hookContext.channelId,
      accountId: params.hookContext.accountId,
      conversationId: params.inboundClaimContext.conversationId,
      sessionKey: params.sessionKey,
      runId: params.replyOptions?.runId,
      senderId: params.hookContext.senderId,
      replyToId: params.hookContext.replyToId,
      replyToBody: params.hookContext.replyToBody,
      replyToSender: params.hookContext.replyToSender,
    },
  );
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
  return { deliveryMode, promptPolicy };
}
