import type { NormalizedUsage } from "../../agents/usage.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { BotConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { estimateUsageCost, formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: BotConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  if (!config) {
    return {};
  }
  const rawProvider = sessionCtx.Provider?.trim().toLowerCase();
  if (!rawProvider) {
    return {};
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., BlueBubbles before plugin registry init)
  const dock = provider ? getChannelDock(provider) : undefined;
  if (!dock?.threading?.buildToolContext) {
    return {
      currentChannelId: sessionCtx.To?.trim() || undefined,
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
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
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since dock exists
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

/**
 * Scope auth profile to a specific provider. Clears the profile if the run's
 * primary provider doesn't match the target (fallback) provider.
 */
export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  if (params.provider !== params.primaryProvider) {
    return { authProfileId: undefined, authProfileIdSource: undefined };
  }
  return {
    authProfileId: params.authProfileId,
    authProfileIdSource: params.authProfileIdSource,
  };
}

/**
 * Resolve auth profile for a run, scoping by provider.
 */
export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
  });
}

/**
 * Build model fallback parameters from a run context.
 */
export function resolveModelFallbackOptions(run: FollowupRun["run"]): {
  cfg: BotConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  fallbacksOverride?: string[];
} {
  return {
    cfg: run.config,
    provider: run.provider,
    model: run.model,
    agentDir: run.agentDir,
    fallbacksOverride: resolveAgentModelFallbacksOverride(run.config, run.agentId ?? ""),
  };
}

/**
 * Build the base embedded run parameters (fields shared across CLI and embedded Pi agent).
 */
export function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  authProfile: { authProfileId?: string; authProfileIdSource?: "auto" | "user" };
}): {
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: BotConfig;
  skillsSnapshot?: FollowupRun["run"]["skillsSnapshot"];
  ownerNumbers?: string[];
  enforceFinalTag: boolean;
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  execOverrides?: FollowupRun["run"]["execOverrides"];
  bashElevated?: FollowupRun["run"]["bashElevated"];
  timeoutMs: number;
  runId: string;
} {
  const { run, provider, model, runId, authProfile } = params;
  return {
    sessionFile: run.sessionFile,
    workspaceDir: run.workspaceDir,
    agentDir: run.agentDir,
    config: run.config,
    skillsSnapshot: run.skillsSnapshot,
    ownerNumbers: run.ownerNumbers,
    enforceFinalTag: resolveEnforceFinalTag(run, provider),
    provider,
    model,
    authProfileId: authProfile.authProfileId,
    authProfileIdSource: authProfile.authProfileIdSource,
    thinkLevel: run.thinkLevel,
    verboseLevel: run.verboseLevel,
    reasoningLevel: run.reasoningLevel,
    execOverrides: run.execOverrides,
    bashElevated: run.bashElevated,
    timeoutMs: run.timeoutMs,
    runId,
  };
}

/**
 * Build embedded agent contexts: auth profile, embedded session context, and sender context.
 */
export function buildEmbeddedRunContexts(params: {
  run: FollowupRun["run"];
  sessionCtx: Partial<TemplateContext>;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
}): {
  authProfile: { authProfileId?: string; authProfileIdSource?: "auto" | "user" };
  embeddedContext: {
    sessionId: string;
    sessionKey?: string;
    agentId?: string;
    messageProvider?: string;
    agentAccountId?: string;
    messageTo?: string;
    messageThreadId?: string | number;
  };
  senderContext: {
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
  };
} {
  const { run, sessionCtx, provider } = params;
  const authProfile = resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
  });
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  const messageTo = resolveOriginMessageTo({
    originatingTo: sessionCtx.OriginatingTo,
    to: sessionCtx.To,
  });
  return {
    authProfile,
    embeddedContext: {
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      agentId: run.agentId,
      messageProvider,
      agentAccountId: run.agentAccountId,
      messageTo,
      messageThreadId:
        sessionCtx.MessageThreadId != null
          ? String(sessionCtx.MessageThreadId).trim() || undefined
          : undefined,
    },
    senderContext: {
      senderId: sessionCtx.SenderId?.trim() || undefined,
      senderName: sessionCtx.SenderName?.trim() || undefined,
      senderUsername: sessionCtx.SenderUsername?.trim() || undefined,
      senderE164: sessionCtx.SenderE164?.trim() || undefined,
    },
  };
}
