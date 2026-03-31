import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { listControlledSubagentRuns } from "../../agents/subagent-control.js";
import { countPendingDescendantRuns } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import { listTasksForAgentId, listTasksForSessionKey } from "../../tasks/task-registry.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

// Some usage endpoints only work with CLI/session OAuth tokens, not API keys.
// Skip those probes when the active auth mode cannot satisfy the endpoint.
const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai-codex",
]);

function shouldLoadUsageSummary(params: {
  provider?: string;
  selectedModelAuth?: string;
}): boolean {
  if (!params.provider) {
    return false;
  }
  if (!USAGE_OAUTH_ONLY_PROVIDERS.has(params.provider)) {
    return true;
  }
  const auth = params.selectedModelAuth?.trim().toLowerCase();
  return Boolean(auth?.startsWith("oauth") || auth?.startsWith("token"));
}

function formatSessionTaskLine(sessionKey: string): string | undefined {
  const tasks = listTasksForSessionKey(sessionKey);
  if (tasks.length === 0) {
    return undefined;
  }
  const latest = tasks[0];
  const active = tasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  ).length;
  const headline = `${active} active · ${tasks.length} total`;
  const title = latest.label?.trim() || latest.task.trim();
  const detail =
    latest.status === "running" || latest.status === "queued"
      ? latest.progressSummary?.trim()
      : latest.error?.trim() || latest.terminalSummary?.trim();
  const parts = [headline, latest.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

function formatAgentTaskCountsLine(agentId: string): string | undefined {
  const tasks = listTasksForAgentId(agentId);
  if (tasks.length === 0) {
    return undefined;
  }
  const active = tasks.filter(
    (task) => task.status === "queued" || task.status === "running",
  ).length;
  return `📌 Tasks: ${active} active · ${tasks.length} total · agent-local`;
}

export async function buildStatusReply(params: {
  cfg: OpenClawConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  provider: string;
  model: string;
  contextTokens: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: boolean;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
}): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    command,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedFastMode,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: provider,
    selectedModel: model,
    sessionEntry,
  });
  const selectedModelAuth = resolveModelAuthLabel({
    provider,
    cfg,
    sessionEntry,
    agentDir: statusAgentDir,
  });
  const activeModelAuth = modelRefs.activeDiffers
    ? resolveModelAuthLabel({
        provider: modelRefs.active.provider,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
      })
    : selectedModelAuth;
  const currentUsageProvider = (() => {
    try {
      return resolveUsageProviderId(provider);
    } catch {
      return undefined;
    }
  })();
  let usageLine: string | null = null;
  if (
    currentUsageProvider &&
    shouldLoadUsageSummary({
      provider: currentUsageProvider,
      selectedModelAuth,
    })
  ) {
    try {
      const usageSummaryTimeoutMs = 3500;
      let usageTimeout: NodeJS.Timeout | undefined;
      const usageSummary = await Promise.race([
        loadProviderUsageSummary({
          timeoutMs: usageSummaryTimeoutMs,
          providers: [currentUsageProvider],
          agentDir: statusAgentDir,
        }),
        new Promise<never>((_, reject) => {
          usageTimeout = setTimeout(
            () => reject(new Error("usage summary timeout")),
            usageSummaryTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (usageTimeout) {
          clearTimeout(usageTimeout);
        }
      });
      const usageEntry = usageSummary.providers[0];
      if (usageEntry && !usageEntry.error && usageEntry.windows.length > 0) {
        const summaryLine = formatUsageWindowSummary(usageEntry, {
          now: Date.now(),
          maxWindows: 2,
          includeResets: true,
        });
        if (summaryLine) {
          usageLine = `📊 Usage: ${summaryLine}`;
        }
      }
    } catch {
      usageLine = null;
    }
  }
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: command.channel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  let taskLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    taskLine = formatSessionTaskLine(requesterKey);
    if (!taskLine) {
      taskLine = formatAgentTaskCountsLine(statusAgentId);
    }
    const runs = listControlledSubagentRuns(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter(
        (entry) => !entry.endedAt || countPendingDescendantRuns(entry.childSessionKey) > 0,
      );
      const done = runs.length - active.length;
      if (verboseEnabled) {
        const labels = active
          .map((entry) => resolveSubagentLabel(entry, ""))
          .filter(Boolean)
          .slice(0, 3);
        const labelText = labels.length ? ` (${labels.join(", ")})` : "";
        subagentsLine = `🤖 Subagents: ${active.length} active${labelText} · ${done} done`;
      } else if (active.length > 0) {
        subagentsLine = `🤖 Subagents: ${active.length} active`;
      }
    }
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const agentConfig = resolveAgentConfig(cfg, statusAgentId);
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      agentId: statusAgentId,
      sessionEntry,
    }).enabled;
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: `${provider}/${model}`,
      },
      contextTokens,
      thinkingDefault: agentConfig?.thinkingDefault ?? agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    explicitConfiguredContextTokens:
      typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0
        ? agentDefaults.contextTokens
        : undefined,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    sessionStorePath: storePath,
    groupActivation,
    resolvedThink: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
    resolvedFast: effectiveFastMode,
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: selectedModelAuth,
    activeModelAuth,
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    taskLine,
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: false,
  });

  return { text: statusText };
}
