import crypto from "node:crypto";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId;

export type SessionChatType = ChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionAcpIdentitySource = "ensure" | "status" | "event";

export type SessionAcpIdentityState = "pending" | "resolved";

export type SessionAcpIdentity = {
  state: SessionAcpIdentityState;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  source: SessionAcpIdentitySource;
  lastUpdatedAt: number;
};

export type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  identity?: SessionAcpIdentity;
  mode: "persistent" | "oneshot";
  runtimeOptions?: AcpSessionRuntimeOptions;
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};

export type AcpSessionRuntimeOptions = {
  /**
   * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
   */
  runtimeMode?: string;
  /** ACP runtime config option: model id. */
  model?: string;
  /** Working directory override for ACP session turns. */
  cwd?: string;
  /** ACP runtime config option: permission profile id. */
  permissionProfile?: string;
  /** ACP runtime config option: per-turn timeout in seconds. */
  timeoutSeconds?: number;
  /** Backend-specific option bag mapped through session/set_config_option. */
  backendExtras?: Record<string, string>;
};

export type CliSessionBinding = {
  sessionId: string;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion?: number;
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
};

export type SessionCompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

export type SessionCompactionTranscriptReference = {
  sessionId: string;
  sessionFile?: string;
  leafId?: string;
  entryId?: string;
};

export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
};

export type SessionPluginDebugEntry = {
  pluginId: string;
  lines: string[];
};

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  /**
   * Base session key for heartbeat-created isolated sessions.
   * When present, `<base>:heartbeat` is a synthetic isolated session rather than
   * a real user/session-scoped key that merely happens to end with `:heartbeat`.
   */
  heartbeatIsolatedBaseSessionKey?: string;
  /** Heartbeat task state (task name -> last run timestamp ms). */
  heartbeatTaskState?: Record<string, number>;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
  spawnedWorkspaceDir?: string;
  /** Explicit parent session linkage for dashboard-created child sessions. */
  parentSessionKey?: string;
  /** True after a thread/topic session has been forked from its parent transcript once. */
  forkedFromParent?: boolean;
  /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
  spawnDepth?: number;
  /** Explicit role assigned at spawn time for subagent tool policy/control decisions. */
  subagentRole?: "orchestrator" | "leaf";
  /** Explicit control scope assigned at spawn time for subagent control decisions. */
  subagentControlScope?: "children" | "none";
  systemSent?: boolean;
  abortedLastRun?: boolean;
  /** Stable first-run start time for subagent sessions, persisted after completion. */
  startedAt?: number;
  /** Latest completed run end time for subagent sessions, persisted after completion. */
  endedAt?: number;
  /** Accumulated runtime across subagent follow-up runs, persisted after completion. */
  runtimeMs?: number;
  /** Final persisted subagent run status, used after in-memory run archival. */
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  /**
   * Session-level stop cutoff captured when /stop is received.
   * Messages at/before this boundary are skipped to avoid replaying
   * queued pre-stop backlog.
   */
  abortCutoffMessageSid?: string;
  /** Epoch ms cutoff paired with abortCutoffMessageSid when available. */
  abortCutoffTimestamp?: number;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  /**
   * Plan-mode session state (PR-8). When `mode === "plan"`, the runtime
   * mutation gate (src/agents/plan-mode/mutation-gate.ts) blocks
   * write/edit/exec/etc. Read-only tools remain available. Set via
   * `sessions.patch { planMode: "plan" | "normal" }` from the UI mode
   * switcher OR by the `enter_plan_mode` agent tool. Clearing back to
   * "normal" releases the gate.
   *
   * Stored as a structural type rather than importing
   * `PlanModeSessionState` from `src/agents/plan-mode/types.ts` to avoid
   * an `agents/*` → `config/sessions/*` dependency on what is still a
   * transitional plan-mode lib (PR #67538). The shape mirrors that type
   * and is enforced via Zod at sessions.patch time.
   */
  planMode?: {
    mode: "plan" | "normal";
    approval: "none" | "pending" | "approved" | "edited" | "rejected" | "timed_out";
    enteredAt?: number;
    confirmedAt?: number;
    updatedAt?: number;
    feedback?: string;
    rejectionCount: number;
    approvalId?: string;
    /**
     * Live-test iteration 1 Bug 2: persisted plan title from the
     * agent's most-recent `exit_plan_mode(title=..., plan=[...])`
     * call. Kept here so the Control UI side panel + future channel
     * renderers can ANCHOR on the actual plan name throughout the
     * lifecycle (planning → submitted → approved → executing →
     * completed) instead of falling back to a generic "Active plan"
     * label. Cleared on the next `enter_plan_mode` cycle.
     *
     * Pre-`exit_plan_mode` (only `update_plan` has fired): undefined.
     * The UI shows `(planning)` until a real title arrives.
     *
     * Written by `plan-snapshot-persister.ts` on
     * `agent_approval_event` ingest (where the title is in
     * `evt.data.title` from the tool result).
     */
    title?: string;
    /**
     * Live-test iteration 1 Bug 3: parent run id captured from the
     * `exit_plan_mode` tool call so the gateway-side approval handler
     * (`sessions-patch.ts`) can look up the parent's
     * `openSubagentRunIds` and reject `approve` / `edit` actions
     * while subagents are still in flight. Cleared on the next
     * `enter_plan_mode` cycle.
     *
     * Distinct from `approvalId` (which identifies the approval
     * request itself for plugin-level routing) — `approvalRunId`
     * identifies the agent run that owns the in-flight subagent set.
     */
    approvalRunId?: string;
    /**
     * PR-8 follow-up: most-recent plan snapshot written by `update_plan`.
     * Persisted here so the Control UI can rebuild the live-plan sidebar
     * after a hard refresh (in-memory `@state()` is lost otherwise). The
     * runtime writes via `sessions.patch`; the UI reads on subscription
     * mount. Deliberately persisted at the SessionEntry layer rather than
     * in a separate store because it's session-scoped and follows the
     * session's lifecycle.
     *
     * PR-9 Wave B1: optional `acceptanceCriteria` + `verifiedCriteria`
     * carry the closure-gate state per step (see
     * `src/agents/tools/update-plan-tool.ts` for the gate semantics).
     * Both are optional and backwards-compatible.
     */
    lastPlanSteps?: Array<{
      step: string;
      status: string;
      activeForm?: string;
      acceptanceCriteria?: string[];
      verifiedCriteria?: string[];
    }>;
    /** Unix ms timestamp of the last `lastPlanSteps` write. */
    lastPlanUpdatedAt?: number;
    /**
     * PR-9 Wave B3: cron job ids scheduled when this session entered
     * plan mode, used to nudge the agent to keep working the plan. The
     * exit-plan-mode handler (and the close-on-complete persister) call
     * `cron.remove` on each id during cleanup so nudges stop firing
     * once the plan resolves.
     */
    nudgeJobIds?: string[];
    /**
     * PR-10 auto-mode: when true, future `exit_plan_mode` submissions
     * auto-resolve as "approve" without waiting for the user. The
     * plan-snapshot-persister (gateway/plan-snapshot-persister.ts)
     * detects this flag and, on receiving a plan approval event, fires
     * a synthetic resolved-approve through `resolvePlanApproval`.
     *
     * Survives plan-mode → normal transitions so the user doesn't have
     * to re-toggle every plan cycle. Cleared explicitly via
     * sessions.patch { planApproval: { action: "auto", autoEnabled: false } }
     * or via the `/plan auto` slash command (PR-11).
     */
    autoApprove?: boolean;
  };
  /**
   * PR-11 review fix (Codex P2 #3105311664 — escalation cluster):
   * timestamp (epoch ms) of the most-recent `approve`/`edit`
   * transition. Stored at SessionEntry ROOT level (NOT under planMode)
   * so it SURVIVES the `mode → "normal"` flip — sessions-patch.ts
   * deletes the entire `planMode` object on close, which would lose
   * any state stored within it.
   *
   * Downstream paths (e.g. `resolveYieldDuringApprovedPlanInstruction`
   * in `pi-embedded-runner/run.ts`) detect "just approved" within a
   * grace window by reading this field instead of depending on
   * `planMode.approval` (cleared on transition).
   *
   * Cleared on the next `enter_plan_mode` cycle so a fresh approval
   * cycle starts from scratch.
   */
  recentlyApprovedAt?: number;
  /**
   * Live-test iteration 3 D2: marker timestamp set at the FIRST
   * `sessions.patch { planMode: "plan" }` transition for this
   * session. Used to gate the one-shot `[PLAN_MODE_INTRO]:` synthetic
   * injection — the intro fires only when this field is undefined,
   * then the field is set so subsequent enter_plan_mode calls in the
   * same session skip the intro (avoiding repeat-noise on every
   * planning cycle).
   *
   * Stored at SessionEntry ROOT (not under `planMode`) so it
   * SURVIVES planMode deletion on approve/edit. Cleared only on
   * `/new` (sessions.reset).
   */
  planModeIntroDeliveredAt?: number;
  /**
   * PR-11 review fix (Codex P1 #3105216364 / #3105247854 / #3105261556 —
   * escalation cluster): when set, this synthetic user-message text is
   * prepended to the next agent turn's user input by the runtime, then
   * cleared. Used by gateway-side handlers to inject signals like
   * `[QUESTION_ANSWER]: <text>` into the agent's context after a
   * `sessions.patch { planApproval: { action: "answer" } }` transition.
   *
   * Single source of truth for inject-on-next-turn signals — replaces
   * the prior pattern where each caller (webchat / Telegram / Discord
   * / Slack `/plan answer` paths) had to manually inject via the
   * channel's message-send infrastructure (which leaked the synthetic
   * marker into user-visible chat history).
   *
   * Cleared by the runtime on first read.
   */
  pendingAgentInjection?: string;
  /**
   * Codex P1 review #68939 (2026-04-19): tracks the most recent
   * `ask_user_question` approvalId so the gateway can validate
   * incoming `/plan answer` patches against an actual pending
   * question. Without this, a stale or accidental `/plan answer`
   * would silently overwrite `pendingAgentInjection` with garbage
   * (potentially clobbering a freshly-written `[PLAN_DECISION]` /
   * `[PLAN_COMPLETE]`).
   *
   * Lifecycle:
   * - WRITE: set by `plan-snapshot-persister.ts` when a question
   *   approval event fires (the runtime intercept in
   *   `pi-embedded-subscribe.handlers.tools.ts:1760` derives the
   *   approvalId deterministically from the toolCallId).
   * - VALIDATE: read by `sessions-patch.ts` in the answer branch —
   *   the incoming `planApproval.approvalId` must match this field
   *   exactly. Mismatched IDs (stale clicks, retried sends after a
   *   newer question landed) get rejected with a friendly error.
   * - CLEAR: deleted by `sessions-patch.ts` after a successful
   *   answer is persisted (one question, one answer — re-asking
   *   requires a fresh `ask_user_question` call).
   */
  pendingQuestionApprovalId?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  /** Session-scoped agent runtime/harness override selected with the model picker. */
  agentRuntimeOverride?: string;
  /**
   * Tracks whether the persisted model override came from an explicit user
   * action (`/model`, `sessions.patch`) or from a temporary runtime fallback.
   * Resets only preserve user-driven overrides.
   */
  modelOverrideSource?: "auto" | "user";
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  /**
   * Set on explicit user-driven session model changes (for example `/model`
   * and `sessions.patch`) during an active run. The embedded runner checks
   * this flag to decide whether to throw `LiveSessionModelSwitchError`.
   * System-initiated fallbacks (rate-limit retry rotation) never set this
   * flag, so they are never mistaken for user-initiated switches.
   */
  liveModelSwitchPending?: boolean;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Whether totalTokens reflects a fresh context snapshot for the latest run.
   * Undefined means legacy/unknown freshness; false forces consumers to treat
   * totalTokens as stale/unknown for context-utilization displays.
   */
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  cacheRead?: number;
  cacheWrite?: number;
  modelProvider?: string;
  model?: string;
  /**
   * Embedded agent harness selected for this session id.
   * Prevents config/env changes from moving an existing transcript between
   * incompatible runtime harnesses.
   */
  agentHarnessId?: string;
  /**
   * Last selected/runtime model pair for which a fallback notice was emitted.
   * Used to avoid repeating the same fallback notice every turn.
   */
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  contextTokens?: number;
  compactionCount?: number;
  compactionCheckpoints?: SessionCompactionCheckpoint[];
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  memoryFlushContextHash?: string;
  cliSessionIds?: Record<string, string>;
  cliSessionBindings?: Record<string, CliSessionBinding>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
  /**
   * Generic plugin-owned runtime debug entries shown in verbose status surfaces.
   * Each plugin owns and may overwrite only its own entry between turns.
   */
  pluginDebugEntries?: SessionPluginDebugEntry[];
  acp?: SessionAcpMeta;
};

function isSessionPluginTraceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("🔎 ") || /(?:^|\s)(?:Debug|Trace):/.test(trimmed);
}

function resolveSessionPluginLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
  includeLine: (line: string) => boolean,
): string[] {
  return Array.isArray(entry?.pluginDebugEntries)
    ? entry.pluginDebugEntries.flatMap((pluginEntry) =>
        Array.isArray(pluginEntry?.lines)
          ? pluginEntry.lines.filter(
              (line): line is string =>
                typeof line === "string" && line.trim().length > 0 && includeLine(line),
            )
          : [],
      )
    : [];
}

export function resolveSessionPluginStatusLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, (line) => !isSessionPluginTraceLine(line));
}

export function resolveSessionPluginTraceLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, isSessionPluginTraceLine);
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeOptionalString(entry.model);
  const normalizedProvider = normalizeOptionalString(entry.modelProvider);
  let next = entry;

  if (!normalizedModel) {
    if (entry.model !== undefined || entry.modelProvider !== undefined) {
      next = { ...next };
      delete next.model;
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.model !== normalizedModel) {
    if (next === entry) {
      next = { ...next };
    }
    next.model = normalizedModel;
  }

  if (!normalizedProvider) {
    if (entry.modelProvider !== undefined) {
      if (next === entry) {
        next = { ...next };
      }
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.modelProvider !== normalizedProvider) {
    if (next === entry) {
      next = { ...next };
    }
    next.modelProvider = normalizedProvider;
  }
  return next;
}

export function setSessionRuntimeModel(
  entry: SessionEntry,
  runtime: { provider: string; model: string },
): boolean {
  const provider = runtime.provider.trim();
  const model = runtime.model.trim();
  if (!provider || !model) {
    return false;
  }
  entry.modelProvider = provider;
  entry.model = model;
  return true;
}

export type SessionEntryMergePolicy = "touch-activity" | "preserve-activity";

type MergeSessionEntryOptions = {
  policy?: SessionEntryMergePolicy;
  now?: number;
};

function resolveMergedUpdatedAt(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): number {
  if (options?.policy === "preserve-activity" && existing) {
    return existing.updatedAt ?? patch.updatedAt ?? options.now ?? Date.now();
  }
  return Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, options?.now ?? Date.now());
}

export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
  }
  const next = { ...existing, ...patch, sessionId, updatedAt };

  // Guard against stale provider carry-over when callers patch runtime model
  // without also patching runtime provider.
  if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
    const patchedModel = normalizeOptionalString(patch.model);
    const existingModel = normalizeOptionalString(existing.model);
    if (patchedModel && patchedModel !== existingModel) {
      delete next.modelProvider;
    }
  }
  return normalizeSessionRuntimeModelFields(next);
}

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch);
}

export function mergeSessionEntryPreserveActivity(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, {
    policy: "preserve-activity",
  });
}

export function resolveSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  return total;
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = resolveSessionTotalTokens(entry);
  if (total === undefined) {
    return undefined;
  }
  if (entry?.totalTokensFresh === false) {
    return undefined;
  }
  return total;
}

export function isSessionTotalTokensFresh(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): boolean {
  return resolveFreshSessionTotalTokens(entry) !== undefined;
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: {
    warningMode?: "off" | "once" | "always";
    warningShown?: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles?: number;
    nearLimitFiles?: number;
    totalNearLimit?: boolean;
  };
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 0;
