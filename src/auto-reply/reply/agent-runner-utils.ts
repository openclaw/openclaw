import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import type { NormalizedUsage } from "../../agents/usage.js";
import { getChannelDock } from "../../channels/dock.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { estimateUsageCost, formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  if (!config) {
    return {
      currentMessageId,
    };
  }
  const rawProvider = sessionCtx.Provider?.trim().toLowerCase();
  if (!rawProvider) {
    return {
      currentMessageId,
    };
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., BlueBubbles before plugin registry init)
  const dock = provider ? getChannelDock(provider) : undefined;
  if (!dock?.threading?.buildToolContext) {
    return {
      currentChannelId: sessionCtx.To?.trim() || undefined,
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
      hasRepliedRef,
    };
  }
  const context =
    dock.threading.buildToolContext({
      cfg: config,
      accountId: sessionCtx.AccountId,
      context: {
        Channel: sessionCtx.Provider,
        From: sessionCtx.From,
        To: sessionCtx.To,
        ChatType: sessionCtx.ChatType,
        CurrentMessageId: currentMessageId,
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since dock exists
    currentMessageId: context.currentMessageId ?? currentMessageId,
  };
}

export const isBunFetchSocketError = (message?: string) =>
  Boolean(message && BUN_FETCH_SOCKET_ERROR_RE.test(message));

export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

export const formatResponseUsageLine = (params: {
  usage?: NormalizedUsage;
  showCost: boolean;
  costConfig?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  if (typeof input !== "number" && typeof output !== "number") {
    return null;
  }
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  const cost =
    params.showCost && typeof input === "number" && typeof output === "number"
      ? estimateUsageCost({
          usage: {
            input,
            output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          cost: params.costConfig,
        })
      : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${suffix}`;
};

export const appendUsageLine = (payloads: ReplyPayload[], line: string): ReplyPayload[] => {
  let index = -1;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return [...payloads, { text: line }];
  }
  const existing = payloads[index];
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = {
    ...existing,
    text: `${existingText}${separator}${line}`,
  };
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};

export const resolveEnforceFinalTag = (run: FollowupRun["run"], provider: string) =>
  Boolean(run.enforceFinalTag || isReasoningTagProvider(provider));

export function resolveModelFallbackOptions(run: FollowupRun["run"]) {
  return {
    cfg: run.config,
    provider: run.provider,
    model: run.model,
    agentDir: run.agentDir,
    fallbacksOverride: resolveAgentModelFallbacksOverride(
      run.config,
      resolveAgentIdFromSessionKey(run.sessionKey),
    ),
  };
}

export function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
}) {
  return {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    agentDir: params.run.agentDir,
    config: params.run.config,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    senderIsOwner: params.run.senderIsOwner,
    enforceFinalTag: resolveEnforceFinalTag(params.run, params.provider),
    provider: params.provider,
    model: params.model,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runId: params.runId,
  };
}

export function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.sessionCtx.OriginatingChannel,
      provider: params.sessionCtx.Provider,
    }),
    agentAccountId: params.sessionCtx.AccountId,
    messageTo: resolveOriginMessageTo({
      originatingTo: params.sessionCtx.OriginatingTo,
      to: params.sessionCtx.To,
    }),
    messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      sessionCtx: params.sessionCtx,
      config: params.run.config,
      hasRepliedRef: params.hasRepliedRef,
    }),
  };
}

export function buildTemplateSenderContext(sessionCtx: TemplateContext) {
  return {
    senderId: sessionCtx.SenderId?.trim() || undefined,
    senderName: sessionCtx.SenderName?.trim() || undefined,
    senderUsername: sessionCtx.SenderUsername?.trim() || undefined,
    senderE164: sessionCtx.SenderE164?.trim() || undefined,
  };
}

export function resolveRunAuthProfile(run: FollowupRun["run"], provider: string) {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
  });
}

export function buildEmbeddedRunContexts(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
}) {
  return {
    authProfile: resolveRunAuthProfile(params.run, params.provider),
    embeddedContext: buildEmbeddedContextFromTemplate({
      run: params.run,
      sessionCtx: params.sessionCtx,
      hasRepliedRef: params.hasRepliedRef,
    }),
    senderContext: buildTemplateSenderContext(params.sessionCtx),
  };
}

export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const authProfileId =
    params.provider === params.primaryProvider ? params.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
  };
}
