import crypto from "node:crypto";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = ChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
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

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
  spawnedWorkspaceDir?: string;
  /** Build-run id inherited by spawned sessions for planner/builder/evaluator handoff. */
  spawnedBuildRunId?: string;
  /** Stable artifact root inherited by spawned sessions for build-loop artifacts. */
  spawnedBuildRunDir?: string;
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
  /** Optional build-loop role preset assigned at spawn time for planner/builder/evaluator semantics. */
  subagentRolePreset?: "planner" | "builder" | "evaluator";
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
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
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
   * Last selected/runtime model pair for which a fallback notice was emitted.
   * Used to avoid repeating the same fallback notice every turn.
   */
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  memoryFlushContextHash?: string;
  cliSessionIds?: Record<string, string>;
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
  verifyReport?: SessionVerifyReport;
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
  acp?: SessionAcpMeta;
};

function normalizeRuntimeField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeRuntimeField(entry.model);
  const normalizedProvider = normalizeRuntimeField(entry.modelProvider);
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
    const patchedModel = normalizeRuntimeField(patch.model);
    const existingModel = normalizeRuntimeField(existing.model);
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

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
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
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
    always?: boolean;
  }>;
  /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionVerifyReport = {
  status: "passed" | "failed" | "skipped";
  strategy: "command-tool";
  generatedAt: number;
  checksRun: number;
  checksPassed: number;
  checksFailed: number;
  reason?: string;
  entries: Array<{
    toolName: string;
    meta?: string;
    command: string;
    kind: "test" | "build" | "lint" | "check" | "command";
    status: "passed" | "failed";
    exitCode: number | null;
    source: "tool-result";
  }>;
};

export type SessionFailureReport = {
  status: "none" | "failed";
  generatedAt: number;
  category:
    | "none"
    | "verification"
    | "tool"
    | "approval"
    | "context"
    | "timeout"
    | "model"
    | "aborted"
    | "retry";
  source: "none" | "verify-runner" | "tool-result" | "run-error" | "assistant-error";
  code:
    | "none"
    | "verify_failed"
    | "tool_error"
    | "approval_error"
    | "context_overflow"
    | "compaction_failure"
    | "role_ordering"
    | "image_size"
    | "retry_limit"
    | "timeout"
    | "assistant_error"
    | "aborted";
  summary: string;
  message?: string;
  toolName?: string;
  toolMeta?: string;
  runErrorKind?:
    | "context_overflow"
    | "compaction_failure"
    | "role_ordering"
    | "image_size"
    | "retry_limit";
  verifyChecksRun?: number;
  verifyChecksFailed?: number;
};

export type SessionRetryReport = {
  status: "unused" | "used" | "exhausted";
  generatedAt: number;
  maxAttempts: number;
  attemptsUsed: number;
  retriesUsed: number;
  remainingRetries: number;
  exhaustedReason?: "retry_limit";
  entries: Array<{
    attempt: number;
    reason:
      | "auth_refresh"
      | "profile_rotation"
      | "thinking_fallback"
      | "overflow_retry"
      | "overflow_compaction"
      | "tool_result_truncation";
    detail?: string;
  }>;
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
  taskProfile?: {
    id: "coding" | "research" | "ops" | "assistant";
    source:
      | "explicit"
      | "session-key"
      | "workspace-dir"
      | "prompt-text"
      | "tool-surface"
      | "default";
    signal?: string;
  };
  workspacePolicyDiscovery?: {
    totalDiscovered: number;
    injectedCount: number;
    candidateCount: number;
    mergeOrder: string[];
    conflictCount: number;
    entries: Array<{
      name: string;
      path: string;
      kind: "bootstrap" | "candidate";
      autoInjected: boolean;
      matchedBy: "bootstrap-name" | "policy-filename" | "policy-directory";
      policyRole:
        | "global-guidance"
        | "repo-focus"
        | "tool-guidance"
        | "persona"
        | "identity"
        | "user-facts"
        | "heartbeat"
        | "bootstrap"
        | "memory"
        | "candidate";
      mergePriority: number;
      mergeTier: "primary" | "supporting" | "specialized" | "candidate";
      source: "workspace-root" | "extra-bootstrap" | "policy-scan";
      conflictSummary?: string;
      conflictWith?: string[];
    }>;
  };
  policySlicing?: {
    totalSlicedChars: number;
    slicedFileCount: number;
    entries: Array<{
      name: string;
      path: string;
      slicedChars: number;
      reasons: string[];
    }>;
  };
  toolPruning?: {
    prunedCount: number;
    prunedSummaryChars: number;
    prunedSchemaChars: number;
    entries: Array<{
      name: string;
      reason: string;
      summaryChars: number;
      schemaChars: number;
    }>;
  };
  skillPruning?: {
    prunedCount: number;
    prunedBlockChars: number;
    entries: Array<{
      name: string;
      reason: string;
      blockChars: number;
    }>;
  };
  delegationProfile?: {
    role: "main" | "orchestrator" | "leaf";
    rolePreset?: "planner" | "builder" | "evaluator";
    promptMode?: "plan" | "build" | "evaluate";
    toolBias?: "read-heavy" | "edit-exec" | "inspect-verify";
    verificationPosture?: "acceptance-first" | "self-check-before-handoff" | "skeptical-review";
    artifactWriteScope?: "planner-artifacts" | "builder-artifacts" | "evaluator-artifacts";
    controlScope: "children" | "none";
    depth: number;
    canSpawn: boolean;
    canControlChildren: boolean;
    workspaceSource: "primary" | "inherited";
    workspaceDir?: string;
    buildRunId?: string;
    buildRunDir?: string;
    parentSessionKey?: string;
    requesterSessionKey?: string;
    task?: string;
    label?: string;
    delegationToolsAllowed: string[];
    delegationToolsBlocked: string[];
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  promptBudget?: {
    totalTrackedChars: number;
    workspaceInjectedChars: number;
    skillsPromptChars: number;
    toolListChars: number;
    otherSystemPromptChars: number;
    toolSchemaChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
    sliced?: boolean;
    slicedChars?: number;
    sliceReasons?: string[];
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
