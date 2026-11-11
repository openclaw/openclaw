import { readToolStringParam } from "../../agents/tools/common.js";
import type { OutboundReplyFacts } from "../../channels/message/types.js";
import type {
  ChannelId,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ResolveAutoThreadId = NonNullable<ChannelThreadingAdapter["resolveAutoThreadId"]>;
type ResolveReplyTransport = NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>;
type MatchesToolContextTarget = NonNullable<ChannelThreadingAdapter["matchesToolContextTarget"]>;

function suppressesImplicitThreading(actionParams: Record<string, unknown>): boolean {
  return actionParams.topLevel === true || actionParams.threadId === null;
}

export function resolveAndApplyOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    resolveAutoThreadId?: ResolveAutoThreadId;
    resolveReplyTransport?: ResolveReplyTransport;
    replyToIsExplicit?: boolean;
  },
): string | undefined {
  const threadId = readToolStringParam(actionParams, "threadId");
  // `topLevel` and explicit null thread ids are caller opt-outs from inherited threading.
  if (!threadId && suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  const replyToId = readToolStringParam(actionParams, "replyTo");
  const autoResolvedThreadId = threadId
    ? undefined
    : context.resolveAutoThreadId?.({
        cfg: context.cfg,
        accountId: context.accountId,
        to: context.to,
        toolContext: context.toolContext,
        // An inherited reply names the incoming message, not a user-selected
        // thread. Let the provider recover its root before canonicalizing it.
        // Passing a Slack child here suppresses root lookup and posts outside
        // the conversation. Explicit and unknown reply targets stay intact.
        replyToId: context.replyToIsExplicit === false ? undefined : replyToId,
      });
  const resolvedThreadId = threadId ?? autoResolvedThreadId;
  if (autoResolvedThreadId && !actionParams.threadId) {
    actionParams.threadId = autoResolvedThreadId;
  }
  if (replyToId && resolvedThreadId) {
    const canonicalReplyToId = context.resolveReplyTransport?.({
      cfg: context.cfg,
      accountId: context.accountId,
      threadId: resolvedThreadId,
      replyToId,
      replyToIsExplicit: context.replyToIsExplicit,
    })?.replyToId;
    // Providers that use one canonical root for reply and thread routing opt in
    // through resolveReplyTransport. Other transports keep message replies intact.
    if (canonicalReplyToId && replyToId !== canonicalReplyToId) {
      actionParams.replyTo = canonicalReplyToId;
    }
  }
  return resolvedThreadId ?? undefined;
}

export function resolveAndApplyOutboundReplyToId(
  actionParams: Record<string, unknown>,
  context: {
    channel: ChannelId;
    toolContext?: ChannelThreadingToolContext;
    matchesToolContextTarget?: MatchesToolContextTarget;
  },
): OutboundReplyFacts | undefined {
  const explicitReplyToId = readToolStringParam(actionParams, "replyTo");
  const configuredMode = context.toolContext?.replyToMode ?? "off";
  const mode = configuredMode === "batched" ? "first" : configuredMode;
  if (explicitReplyToId) {
    if (mode === "first") {
      const hasRepliedRef = context.toolContext?.hasRepliedRef;
      if (hasRepliedRef) {
        hasRepliedRef.value = true;
      }
    }
    return { replyToId: explicitReplyToId, source: "explicit" };
  }
  if (suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  const { channel, toolContext, matchesToolContextTarget } = context;
  const currentChannelId = toolContext?.currentChannelId?.trim();
  const currentMessagingTarget = toolContext?.currentMessagingTarget?.trim();
  if (!currentChannelId && !currentMessagingTarget) {
    return undefined;
  }
  const currentChannelProvider = toolContext?.currentChannelProvider?.trim();
  if (currentChannelProvider && currentChannelProvider !== channel) {
    return undefined;
  }
  const explicitTarget =
    readToolStringParam(actionParams, "target") ??
    readToolStringParam(actionParams, "to") ??
    readToolStringParam(actionParams, "channelId");
  if (explicitTarget) {
    const target = explicitTarget.trim();
    if (
      !(toolContext && matchesToolContextTarget?.({ target, toolContext })) &&
      target !== currentMessagingTarget &&
      target !== currentChannelId
    ) {
      return undefined;
    }
  }
  const currentMessageId = context.toolContext?.currentMessageId;
  if (currentMessageId == null || mode === "off") {
    return undefined;
  }

  if (mode === "first") {
    const hasRepliedRef = context.toolContext?.hasRepliedRef;
    if (hasRepliedRef?.value) {
      return undefined;
    }
    // First-reply mode consumes the current inbound message once across batched sends.
    if (hasRepliedRef) {
      hasRepliedRef.value = true;
    }
  }

  const resolvedReplyToId =
    typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
  if (!resolvedReplyToId) {
    return undefined;
  }
  actionParams.replyTo = resolvedReplyToId;
  return { replyToId: resolvedReplyToId, source: "implicit", mode };
}
