import { readStringParam, ToolInputError } from "../../agents/tools/common.js";
import type {
  ChannelId,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  OutboundSessionRoute,
  ResolveOutboundSessionRouteParams,
} from "./outbound-session.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

type ResolveAutoThreadId = NonNullable<ChannelThreadingAdapter["resolveAutoThreadId"]>;

const THREADING_CONTROL_PARAM_KEYS = {
  threadId: ["threadId", "thread_id"],
  topLevel: ["topLevel", "top_level"],
} as const;

function readThreadingControlParam(
  actionParams: Record<string, unknown>,
  key: keyof typeof THREADING_CONTROL_PARAM_KEYS,
): unknown {
  for (const candidate of THREADING_CONTROL_PARAM_KEYS[key]) {
    let hasKey = false;
    try {
      hasKey = Object.hasOwn(actionParams, candidate);
    } catch {
      throw new ToolInputError("message action params could not be read");
    }
    if (!hasKey) {
      continue;
    }
    try {
      return actionParams[candidate];
    } catch {
      throw new ToolInputError(`${candidate} could not be read`);
    }
  }
  return undefined;
}

function suppressesImplicitThreading(actionParams: Record<string, unknown>): boolean {
  return (
    readThreadingControlParam(actionParams, "topLevel") === true ||
    readThreadingControlParam(actionParams, "threadId") === null
  );
}

function shouldApplyResolvedThreadId(actionParams: Record<string, unknown>): boolean {
  let hasThreadId = false;
  try {
    hasThreadId = Object.hasOwn(actionParams, "threadId");
  } catch {
    throw new ToolInputError("message action params could not be read");
  }
  if (!hasThreadId) {
    return true;
  }
  try {
    return !actionParams.threadId;
  } catch {
    throw new ToolInputError("threadId could not be read");
  }
}

function writeThreadingParam(
  actionParams: Record<string, unknown>,
  key: "__agentId" | "__sessionKey" | "replyTo" | "threadId",
  value: string,
) {
  try {
    actionParams[key] = value;
  } catch {
    throw new ToolInputError(`${key} could not be written`);
  }
}

export function resolveAndApplyOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    resolveAutoThreadId?: ResolveAutoThreadId;
  },
): string | undefined {
  const threadId = readStringParam(actionParams, "threadId");
  if (!threadId && suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  const resolved =
    threadId ??
    context.resolveAutoThreadId?.({
      cfg: context.cfg,
      accountId: context.accountId,
      to: context.to,
      toolContext: context.toolContext,
      replyToId: readStringParam(actionParams, "replyTo"),
    });
  if (resolved && shouldApplyResolvedThreadId(actionParams)) {
    writeThreadingParam(actionParams, "threadId", resolved);
  }
  return resolved ?? undefined;
}

function isSameConversationTarget(
  actionParams: Record<string, unknown>,
  channel: ChannelId,
  toolContext?: ChannelThreadingToolContext,
): boolean {
  const currentChannelId = toolContext?.currentChannelId?.trim();
  if (!currentChannelId) {
    return false;
  }
  const currentChannelProvider = toolContext?.currentChannelProvider?.trim();
  if (currentChannelProvider && currentChannelProvider !== channel) {
    return false;
  }
  const explicitTarget =
    readStringParam(actionParams, "target") ??
    readStringParam(actionParams, "to") ??
    readStringParam(actionParams, "channelId");
  if (!explicitTarget) {
    return true;
  }
  return explicitTarget.trim() === currentChannelId;
}

export function resolveAndApplyOutboundReplyToId(
  actionParams: Record<string, unknown>,
  context: {
    channel: ChannelId;
    toolContext?: ChannelThreadingToolContext;
  },
): string | undefined {
  const explicitReplyToId = readStringParam(actionParams, "replyTo");
  if (explicitReplyToId) {
    if (context.toolContext?.replyToMode === "first") {
      const hasRepliedRef = context.toolContext.hasRepliedRef;
      if (hasRepliedRef) {
        hasRepliedRef.value = true;
      }
    }
    return explicitReplyToId;
  }
  if (suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  if (!isSameConversationTarget(actionParams, context.channel, context.toolContext)) {
    return undefined;
  }

  const currentMessageId = context.toolContext?.currentMessageId;
  if (currentMessageId == null) {
    return undefined;
  }

  const mode = context.toolContext?.replyToMode ?? "off";
  if (mode === "off" || mode === "batched") {
    return undefined;
  }

  if (mode === "first") {
    const hasRepliedRef = context.toolContext?.hasRepliedRef;
    if (hasRepliedRef?.value) {
      return undefined;
    }
    if (hasRepliedRef) {
      hasRepliedRef.value = true;
    }
  }

  const resolvedReplyToId =
    typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
  if (!resolvedReplyToId) {
    return undefined;
  }
  writeThreadingParam(actionParams, "replyTo", resolvedReplyToId);
  return resolvedReplyToId;
}

export async function prepareOutboundMirrorRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  to: string;
  actionParams: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string;
  currentSessionKey?: string;
  dryRun?: boolean;
  resolvedTarget?: ResolvedMessagingTarget;
  resolveAutoThreadId?: ResolveAutoThreadId;
  resolveOutboundSessionRoute: (
    params: ResolveOutboundSessionRouteParams,
  ) => Promise<OutboundSessionRoute | null>;
  ensureOutboundSessionEntry: (params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    accountId?: string | null;
    route: OutboundSessionRoute;
  }) => Promise<void>;
}): Promise<{
  resolvedThreadId?: string;
  outboundRoute: OutboundSessionRoute | null;
}> {
  const replyToId = readStringParam(params.actionParams, "replyTo");
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    toolContext: params.toolContext,
    resolveAutoThreadId: params.resolveAutoThreadId,
  });
  const outboundRoute =
    params.agentId && !params.dryRun
      ? await params.resolveOutboundSessionRoute({
          cfg: params.cfg,
          channel: params.channel,
          agentId: params.agentId,
          accountId: params.accountId,
          target: params.to,
          currentSessionKey: params.currentSessionKey,
          resolvedTarget: params.resolvedTarget,
          replyToId,
          threadId: resolvedThreadId,
        })
      : null;
  if (outboundRoute && params.agentId && !params.dryRun) {
    await params.ensureOutboundSessionEntry({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      route: outboundRoute,
    });
  }
  if (outboundRoute && !params.dryRun) {
    writeThreadingParam(params.actionParams, "__sessionKey", outboundRoute.sessionKey);
  }
  if (params.agentId) {
    writeThreadingParam(params.actionParams, "__agentId", params.agentId);
  }
  return {
    resolvedThreadId,
    outboundRoute,
  };
}
