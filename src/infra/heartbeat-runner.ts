// Runs heartbeat checks and emits status updates for configured agents.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/run-state.js";
import { formatReasoningMessage } from "../agents/embedded-agent-utils.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveModelRefFromString, type ModelRef } from "../agents/model-selection.js";
import { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
import {
  getHeartbeatToolNotificationText,
  resolveHeartbeatToolResponseFromReplyResult,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  isHeartbeatContentEffectivelyEmpty,
  isTaskDue,
  parseHeartbeatTasks,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  resolveHeartbeatPromptForResponseTool,
  stripHeartbeatToken,
  type HeartbeatTask,
} from "../auto-reply/heartbeat.js";
import { replaceGenericExternalRunFailureText } from "../auto-reply/reply/agent-runner-failure-copy.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import {
  listActiveReplyRunSessionKeys,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type {
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import {
  listDueCommitmentsForSession,
  listDueCommitmentSessionKeys,
  markCommitmentsAttempted,
  markCommitmentsStatus,
} from "../commitments/store.js";
import type { CommitmentRecord } from "../commitments/types.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasActiveCronJobs } from "../cron/active-jobs.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  getCommandLaneSnapshots,
  getQueueSize,
  type CommandLaneSnapshot,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { escapeRegExp } from "../utils.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS, resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { resolveMainScopedEventSessionKey } from "./event-session-routing.js";
import { isWithinActiveHours, resolveActiveHoursTimezone } from "./heartbeat-active-hours.js";
import { recordRunStart, shouldDeferWake, type DeferDecision } from "./heartbeat-cooldown.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { HEARTBEAT_RUN_SCOPE, type HeartbeatRunScope } from "./heartbeat-run-scope.js";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs,
} from "./heartbeat-schedule.js";
import { isHeartbeatEnabledForAgent, resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  areHeartbeatsEnabled,
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_LANES_BUSY,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  type HeartbeatWakeIntent,
  type HeartbeatWakeRequest,
  type HeartbeatWakeSource,
  isRetryableHeartbeatBusySkipReason,
  requestHeartbeat,
  setHeartbeatsEnabled,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  resolveHeartbeatDeliveryTargetWithSessionRoute,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("./heartbeat-runner.runtime.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    getCommandLaneSnapshots?: () => readonly CommandLaneSnapshot[];
    isReplyRunActive?: (sessionKey: string) => boolean;
    listActiveReplyRunSessionKeys?: () => readonly string[];
    listActiveEmbeddedRunSessionKeys?: () => readonly string[];
    nowMs?: () => number;
  };

const log = createSubsystemLogger("gateway/heartbeat");

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("./heartbeat-runner.runtime.js"),
);

const HEARTBEAT_ALWAYS_BUSY_LANES = [CommandLane.Cron, CommandLane.CronNested] as const;
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 10 * 60;

function hasQueuedWorkInLanes(
  lanes: readonly string[],
  getSize: (lane?: string) => number,
): boolean {
  return lanes.some((lane) => getSize(lane) > 0);
}

function hasQueuedWorkInLaneSnapshots(
  snapshots: readonly CommandLaneSnapshot[],
  matchesLane: (lane: string) => boolean,
): boolean {
  return snapshots.some(
    (snapshot) => matchesLane(snapshot.lane) && snapshot.activeCount + snapshot.queuedCount > 0,
  );
}

/**
 * Return true when `lane` carries a session-key suffix that parses to
 * `agentId`. Lane name shapes covered:
 *
 * - `session:agent:<agentId>:...` — embedded-runner per-session lanes
 *   (subagent runs, compaction, context maintenance).
 * - `nested:agent:<agentId>:...` — per-session nested-agent lanes.
 *
 * The generic `subagent` and `nested` global lanes carry no agent identity,
 * so they cannot be scoped here; rely on the session-keyed variants and the
 * per-session `session-lane-busy` skip at the heartbeat dispatch site.
 */
function laneBelongsToAgent(lane: string, agentId: string): boolean {
  let suffix: string | undefined;
  if (lane.startsWith("session:")) {
    suffix = lane.slice("session:".length);
  } else if (lane.startsWith("nested:")) {
    suffix = lane.slice("nested:".length);
  }
  if (!suffix) {
    return false;
  }
  const parsed = parseAgentSessionKey(suffix);
  if (!parsed) {
    return false;
  }
  return normalizeAgentId(parsed.agentId) === normalizeAgentId(agentId);
}

/**
 * Per-agent variant of the opt-in busy check. Previously the runner consulted
 * a global `subagent` lane size, which meant a zombie subagent on any one
 * agent silently disabled every other agent's heartbeat. Restrict the check
 * to lanes attributable to `agentId` via session-key parsing so a stuck
 * subagent on `main` no longer starves `tank`, `narcissus`, or `shiva`.
 */
function hasAgentOptInBusyLaneWork(
  agentId: string,
  getSnapshots: () => readonly CommandLaneSnapshot[],
): boolean {
  return hasQueuedWorkInLaneSnapshots(getSnapshots(), (lane) => laneBelongsToAgent(lane, agentId));
}

function hasActiveRunForAgent(agentId: string, listSessionKeys: () => readonly string[]): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  return listSessionKeys().some((sessionKey) => {
    const parsed = parseAgentSessionKey(sessionKey);
    return parsed ? normalizeAgentId(parsed.agentId) === normalizedAgentId : false;
  });
}

function hasActiveRunForSession(
  sessionKey: string,
  listSessionKeys: () => readonly string[],
): boolean {
  const normalizedSessionKey = sessionKey.trim();
  return Boolean(normalizedSessionKey) && listSessionKeys().includes(normalizedSessionKey);
}

function resolveHeartbeatChannelPlugin(channel: string): ChannelPlugin | undefined {
  const activePlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  return activePlugin ?? getChannelPlugin(channel as ChannelId);
}

function resolveHeartbeatTimeoutOverrideSeconds(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  if (typeof heartbeat?.timeoutSeconds === "number") {
    return heartbeat.timeoutSeconds;
  }
  const agentDefaultTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
  if (
    typeof agentDefaultTimeoutSeconds === "number" &&
    Number.isFinite(agentDefaultTimeoutSeconds)
  ) {
    return Math.max(1, Math.floor(agentDefaultTimeoutSeconds));
  }
  // The wake dispatcher awaits heartbeat turns serially. Keep unset heartbeat
  // timeouts tied to the cadence instead of the 48h built-in agent default.
  const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  if (!intervalMs) {
    return DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, Math.ceil(intervalMs / 1000)));
}

export { areHeartbeatsEnabled, setHeartbeatsEnabled };
export {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "./heartbeat-summary.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export { isCronSystemEvent };

function canHeartbeatDeliverCommitments(heartbeat?: HeartbeatConfig): boolean {
  return (normalizeOptionalString(heartbeat?.target) ?? "none") !== "none";
}

type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  activeHoursSchedule?: ActiveHoursSchedule;
  intervalMs: number;
  phaseMs: number;
  nextDueMs: number;
  /** Wall-clock start time of the most recent run for this agent. */
  lastRunStartedAtMs?: number;
  /** Bounded ring buffer of recent run-start timestamps for flood detection. */
  recentRunStarts: number[];
  /** Set true after a flood-defer is logged to avoid log spam. Reset when a run actually fires. */
  floodLoggedSinceLastRun: boolean;
};

type ActiveHoursSchedule = {
  start?: string;
  end?: string;
  timezone: string;
};

function resolveActiveHoursSchedule(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
): ActiveHoursSchedule | undefined {
  const activeHours = heartbeat?.activeHours;
  if (!activeHours) {
    return undefined;
  }
  return {
    start: activeHours.start,
    end: activeHours.end,
    timezone: resolveActiveHoursTimezone(cfg, activeHours.timezone),
  };
}

function activeHoursConfigMatch(a?: ActiveHoursSchedule, b?: ActiveHoursSchedule): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.start === b.start && a.end === b.end && a.timezone === b.timezone;
}

export type HeartbeatRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function resolveHeartbeatSchedulerSeed(explicitSeed?: string) {
  const normalized = normalizeOptionalString(explicitSeed);
  if (normalized) {
    return normalized;
  }
  try {
    return loadOrCreateDeviceIdentity().deviceId;
  } catch {
    return createHash("sha256")
      .update(process.env.HOME ?? "")
      .update("\0")
      .update(process.cwd())
      .digest("hex");
  }
}

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

function omitExplicitHeartbeatDestination(heartbeat: HeartbeatConfig | undefined) {
  if (!heartbeat) {
    return undefined;
  }
  const next = { ...heartbeat };
  delete next.to;
  delete next.accountId;
  return next;
}

function resolveHeartbeatForWake(params: {
  cfg: OpenClawConfig;
  agentId: string;
  configuredHeartbeat?: HeartbeatConfig;
  requestedHeartbeat?: HeartbeatConfig;
  source?: HeartbeatWakeSource;
  mergeRequestedHeartbeat: boolean;
}): HeartbeatConfig | undefined {
  const base = params.configuredHeartbeat ?? resolveHeartbeatConfig(params.cfg, params.agentId);
  const heartbeat =
    params.requestedHeartbeat && params.mergeRequestedHeartbeat
      ? { ...base, ...params.requestedHeartbeat }
      : (params.requestedHeartbeat ?? base);
  return params.source === "cron" && params.requestedHeartbeat?.target === "last"
    ? omitExplicitHeartbeatDestination(heartbeat)
    : heartbeat;
}

function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const list = cfg.agents?.list ?? [];
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg).map((agentId) => ({
      agentId,
      heartbeat: resolveHeartbeatConfig(cfg, agentId),
    }));
  }
  const fallbackId = resolveDefaultAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

function resolveHeartbeatPromptRaw(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt;
}

export function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

function resolveHeartbeatResponseToolPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptForResponseTool(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

function resolveHeartbeatModelRef(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
}): ModelRef {
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRaw =
    normalizeOptionalString(params.heartbeat?.model) ??
    normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model) ??
    "";
  const heartbeatRef = heartbeatRaw
    ? resolveModelRefFromString({
        raw: heartbeatRaw,
        defaultProvider,
        aliasIndex,
      })?.ref
    : undefined;
  if (heartbeatRef) {
    return heartbeatRef;
  }
  return {
    provider: normalizeOptionalString(params.entry?.modelProvider) ?? defaultProvider,
    model: normalizeOptionalString(params.entry?.model) ?? defaultModel,
  };
}

function usesCodexHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
}): boolean {
  const persistedRuntimeId = resolvePersistedSessionRuntimeId(params.entry);
  if (persistedRuntimeId === "codex") {
    return true;
  }
  if (persistedRuntimeId && persistedRuntimeId !== "auto") {
    return false;
  }
  const modelRef = resolveHeartbeatModelRef(params);
  const policy = resolveAgentHarnessPolicy({
    config: params.cfg,
    provider: modelRef.provider,
    modelId: modelRef.model,
    agentId: params.agentId,
  });
  const runtimeId = normalizeOptionalAgentRuntimeId(policy.runtime);
  if (runtimeId === "codex") {
    return true;
  }
  if (runtimeId && runtimeId !== "auto") {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(modelRef.provider) === "codex";
}

function shouldUseHeartbeatResponseToolPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  chatType?: ChatType;
}): boolean {
  const chatType = normalizeChatType(params.chatType);
  const visibleReplies =
    chatType === "group" || chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  if (visibleReplies === "message_tool") {
    return true;
  }
  if (visibleReplies === "automatic") {
    return false;
  }
  return usesCodexHarness(params);
}

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return Math.max(
    0,
    heartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function isHeartbeatTypingEnabled(params: { cfg: OpenClawConfig; hasChatDelivery: boolean }) {
  if (!params.hasChatDelivery) {
    return false;
  }
  const agentCfg = params.cfg.agents?.defaults;
  const typingMode = params.cfg.session?.typingMode ?? agentCfg?.typingMode;
  return typingMode !== "never";
}

function resolveHeartbeatTypingIntervalSeconds(cfg: OpenClawConfig) {
  const agentCfg = cfg.agents?.defaults;
  const configured = agentCfg?.typingIntervalSeconds ?? cfg.session?.typingIntervalSeconds;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const store = loadSessionStore(storePath);
  const mainEntry = store[mainSessionKey];

  if (scope === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: true,
    };
  }

  if (forced && !isSubagentSessionKey(forced)) {
    const forcedCandidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey: forced,
      mainKey: cfg.session?.mainKey,
    });
    if (!isSubagentSessionKey(forcedCandidate)) {
      const forcedCanonical = canonicalizeMainSessionAlias({
        cfg,
        agentId: resolvedAgentId,
        sessionKey: forcedCandidate,
      });
      if (forcedCanonical !== "global" && !isSubagentSessionKey(forcedCanonical)) {
        const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);
        if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
          const routedSessionKey =
            resolveMainScopedEventSessionKey({
              cfg,
              sessionKey: forcedCanonical,
              agentId: resolvedAgentId,
            }) ?? forcedCanonical;
          return {
            sessionKey: routedSessionKey,
            storePath,
            store,
            entry: store[routedSessionKey],
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  if (isSubagentSessionKey(candidate)) {
    return {
      sessionKey: mainSessionKey,
      storePath,
      store,
      entry: mainEntry,
      suppressOriginatingContext: false,
    };
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global" && !isSubagentSessionKey(canonical)) {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        store,
        entry: store[canonical],
        suppressOriginatingContext: false,
      };
    }
  }

  return {
    sessionKey: mainSessionKey,
    storePath,
    store,
    entry: mainEntry,
    suppressOriginatingContext: false,
  };
}
