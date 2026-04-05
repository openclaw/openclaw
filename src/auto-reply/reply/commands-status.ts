import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "../../agents/subagent-registry-queries.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "../../agents/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import {
  listTasksForAgentIdForStatus,
  listTasksForSessionKeyForStatus,
} from "../../tasks/task-status-access.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../../tasks/task-status.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { buildStatusMessage } from "../status-card.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { resolveQueueSettings } from "./queue/settings.js";

// Some usage endpoints only work with CLI/session OAuth tokens, not API keys.
// Skip those probes when the active auth mode cannot satisfy the endpoint.
const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai-codex",
]);

let providerUsageModulePromise: Promise<typeof import("../../infra/provider-usage.js")> | null =
  null;
async function loadProviderUsageModule() {
  providerUsageModulePromise ??= import("../../infra/provider-usage.js");
  return await providerUsageModulePromise;
}

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
  const snapshot = buildTaskStatusSnapshot(listTasksForSessionKeyForStatus(sessionKey));
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active · ${snapshot.totalCount} total`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : "recently finished";
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const parts = [headline, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

function formatAgentTaskCountsLine(agentId: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
  if (snapshot.totalCount === 0) {
    return undefined;
  }
  return `📌 Tasks: ${snapshot.activeCount} active · ${snapshot.totalCount} total · agent-local`;
}

function resolveModelAuthLabelLight(params: {
  provider?: string;
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
}): string | undefined {
  const providerKey = params.provider?.trim().toLowerCase();
  if (!providerKey) {
    return undefined;
  }
  const providerConfig = (
    params.cfg as
      | {
          models?: {
            providers?: Record<string, { apiKey?: string; token?: string; oauthToken?: string }>;
          };
        }
      | undefined
  )?.models?.providers?.[providerKey];
  if (providerConfig?.oauthToken?.trim()) {
    return "oauth";
  }
  if (providerConfig?.token?.trim()) {
    return "token";
  }
  if (providerConfig?.apiKey?.trim()) {
    return "api-key";
  }
  if (params.sessionEntry?.authProfileOverride?.trim()) {
    return "api-key";
  }
  return "unknown";
}

function resolveFastModeStateLight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry?: SessionEntry;
}): { enabled: boolean } {
  if (typeof params.sessionEntry?.fastMode === "boolean") {
    return { enabled: params.sessionEntry.fastMode };
  }
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  if (typeof agentConfig?.fastModeDefault === "boolean") {
    return { enabled: agentConfig.fastModeDefault };
  }
  return { enabled: false };
}

function sortSubagentRunsLight(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

function resolveSubagentLabelLight(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || fallback;
}

function getFollowupQueueDepthLight(_sessionKey: string): number {
  return 0;
}

function listControlledSubagentRunsLight(controllerSessionKey: string) {
  const filtered: ReturnType<typeof listSubagentRunsForController> = [];
  for (const entry of sortSubagentRunsLight(listSubagentRunsForController(controllerSessionKey))) {
    const latest = getLatestSubagentRunByChildSessionKey(entry.childSessionKey);
    const latestControllerSessionKey =
      latest?.controllerSessionKey?.trim() || latest?.requesterSessionKey?.trim();
    if (
      !latest ||
      latest.runId !== entry.runId ||
      latestControllerSessionKey !== controllerSessionKey
    ) {
      continue;
    }
    filtered.push(entry);
  }
  return filtered;
}

export async function buildStatusReply(params: {
  cfg: OpenClawConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  workspaceDir?: string;
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
  const { command } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }

  const statusAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : resolveDefaultAgentId(params.cfg);
  const headerLines = [
    `Agent: ${statusAgentId}`,
    ...(params.workspaceDir ? [`Workspace: ${params.workspaceDir}`] : []),
  ];
  const text = await buildStatusText({
    ...params,
    statusChannel: command.channel,
  });
  return {
    text: [headerLines.join("\n"), "", text].join("\n"),
  };
}

export async function buildStatusText(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  statusChannel: string;
  provider: string;
  model: string;
  contextTokens?: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: boolean;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
  taskLineOverride?: string;
  skipDefaultTaskLookup?: boolean;
  primaryModelLabelOverride?: string;
  modelAuthOverride?: string;
  activeModelAuthOverride?: string;
}): Promise<string> {
  const {
    cfg,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    statusChannel,
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
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: provider,
    selectedModel: model,
    sessionEntry,
  });
  const selectedModelAuth = Object.hasOwn(params, "modelAuthOverride")
    ? params.modelAuthOverride
    : resolveModelAuthLabelLight({
        provider,
        cfg,
        sessionEntry,
      });
  const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride")
    ? params.activeModelAuthOverride
    : modelRefs.activeDiffers
      ? resolveModelAuthLabelLight({
          provider: modelRefs.active.provider,
          cfg,
          sessionEntry,
        })
      : selectedModelAuth;
  const currentUsageProvider = (() => {
    try {
      // Avoid importing the provider-usage runtime during module load.
      // This path is only needed when we actually build a status reply.
      return provider;
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
      const { formatUsageWindowSummary, loadProviderUsageSummary, resolveUsageProviderId } =
        await loadProviderUsageModule();
      const usageProviderId = resolveUsageProviderId(provider);
      if (!usageProviderId) {
        throw new Error(`unsupported usage provider: ${provider}`);
      }
      const usageSummaryTimeoutMs = 3500;
      let usageTimeout: NodeJS.Timeout | undefined;
      const usageSummary = await Promise.race([
        loadProviderUsageSummary({
          timeoutMs: usageSummaryTimeoutMs,
          providers: [usageProviderId],
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
    channel: statusChannel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepthLight(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  let taskLine: string | undefined;
  if (sessionKey) {
    const requesterKey = sessionKey;
    taskLine = params.skipDefaultTaskLookup
      ? params.taskLineOverride
      : (params.taskLineOverride ?? formatSessionTaskLine(requesterKey));
    if (!taskLine && !params.skipDefaultTaskLookup) {
      taskLine = formatAgentTaskCountsLine(statusAgentId);
    }
    const runs = listControlledSubagentRunsLight(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter(
        (entry) =>
          !entry.endedAt ||
          countPendingDescendantRunsFromRuns(subagentRuns, entry.childSessionKey) > 0,
      );
      const done = runs.length - active.length;
      if (verboseEnabled) {
        const labels = active
          .map((entry) => resolveSubagentLabelLight(entry, ""))
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
    resolveFastModeStateLight({
      cfg,
      agentId: statusAgentId,
      sessionEntry,
    }).enabled;
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: params.primaryModelLabelOverride ?? `${provider}/${model}`,
      },
      ...(typeof contextTokens === "number" && contextTokens > 0 ? { contextTokens } : {}),
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

  return statusText;
}
