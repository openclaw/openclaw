/**
 * Meta-Harness runtime wiring
 *
 * Connects the meta-harness module to OpenClaw's runtime via the internal
 * hook system and a lightweight onToolResult wrapper.
 *
 * Design principles:
 * - No new event types — only listens to existing hooks
 * - Workspace-gated — no-ops when manifest.json is absent
 * - Session-keyed — tracks active flow builders per session
 * - Fire-and-forget — trace errors never block the main reply path
 */

import type { InternalHookEvent } from "../hooks/internal-hooks.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createFlowTraceBuilder, checkWorkspaceGating } from "./index.js";
import type { FlowTraceBuilder } from "./index.js";
import type {
  RunOutcome,
  ToolOutcome,
  TriggerKind,
  TriageDomain,
  AutomationLevel,
} from "./types.js";

const log = createSubsystemLogger("meta-harness");

// ---------------------------------------------------------------------------
// Session-keyed active flow builder tracking
// ---------------------------------------------------------------------------

// Use a wrapper to avoid "error type in union" lint issues with FlowTraceBuilder
type ActiveBuilder = { builder: FlowTraceBuilder };

const activeBuilders = new Map<string, ActiveBuilder>();

function getBuilder(sessionKey: string): ActiveBuilder | undefined {
  return activeBuilders.get(sessionKey);
}

function setBuilder(sessionKey: string, builder: FlowTraceBuilder): void {
  // Clean up any previous builder (leaked sessions)
  const prev = activeBuilders.get(sessionKey);
  if (prev) {
    finalizeBuilder(prev.builder, "aborted").catch(() => {});
  }
  activeBuilders.set(sessionKey, { builder });
}

function removeBuilder(sessionKey: string): void {
  activeBuilders.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

let defaultWorkspaceDir: string | null = null;

function getWorkspaceDir(context: Record<string, unknown>): string | null {
  // Prefer explicit workspace dir from hook context
  if (typeof context.workspaceDir === "string" && context.workspaceDir) {
    return context.workspaceDir;
  }
  return defaultWorkspaceDir;
}

async function initializeWorkspace(workspaceDir: string): Promise<boolean> {
  const gating = await checkWorkspaceGating(workspaceDir);
  if (!gating.enabled) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Flow lifecycle
// ---------------------------------------------------------------------------

function inferTriageDomain(trigger: TriggerKind): TriageDomain {
  if (trigger === "heartbeat" || trigger === "cron") {
    return "ops";
  }
  return "research";
}

function inferAutomationLevel(trigger: TriggerKind): AutomationLevel {
  if (trigger === "heartbeat" || trigger === "cron") {
    return "A";
  }
  return "B";
}

function startFlowTrace(params: {
  sessionKey: string;
  workspaceDir: string;
  trigger: TriggerKind;
  taskSummary: string;
  // eslint-disable-next-line typescript-eslint/no-redundant-type-constituents
}): FlowTraceBuilder | undefined {
  const builder = createFlowTraceBuilder({
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionKey,
    flowId: params.sessionKey,
    trigger: params.trigger,
    taskSummary: params.taskSummary,
    triageDomain: inferTriageDomain(params.trigger),
    automationLevel: inferAutomationLevel(params.trigger),
  });
  if (builder) {
    setBuilder(params.sessionKey, builder);
    log.debug(`flow trace started: ${builder.traceId} (${params.trigger})`);
  }
  return builder ?? undefined;
}

async function finalizeBuilder(builder: FlowTraceBuilder, outcome: RunOutcome): Promise<void> {
  try {
    const filePath = await builder.finalize(outcome);
    if (filePath) {
      log.debug(`flow trace finalized: ${builder.traceId} -> ${outcome}`);
    }
  } catch (err) {
    log.error(`flow trace finalize failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Hook: gateway:startup — initialize workspace
// ---------------------------------------------------------------------------

async function handleGatewayStartup(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as { workspaceDir?: string };
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }

  defaultWorkspaceDir = workspaceDir;

  const enabled = await initializeWorkspace(workspaceDir);
  if (!enabled) {
    log.debug("meta-harness disabled (no manifest)");
    return;
  }

  log.info("meta-harness initialized for workspace");
}

// ---------------------------------------------------------------------------
// Hook: message:received — start session flow trace
// ---------------------------------------------------------------------------

async function handleMessageReceived(event: InternalHookEvent): Promise<void> {
  const workspaceDir = getWorkspaceDir(event.context);
  if (!workspaceDir) {
    return;
  }

  const gating = await checkWorkspaceGating(workspaceDir);
  if (!gating.enabled) {
    return;
  }

  const ctx = event.context as {
    content?: string;
    channelId?: string;
    from?: string;
  };

  // Don't trace heartbeat messages (those have their own trigger)
  const content = typeof ctx.content === "string" ? ctx.content.trim() : "";
  if (content.startsWith("Read HEARTBEAT.md") || content === "HEARTBEAT_OK") {
    return;
  }

  startFlowTrace({
    sessionKey: event.sessionKey,
    workspaceDir,
    trigger: "session",
    taskSummary: content.slice(0, 500),
  });
}

// ---------------------------------------------------------------------------
// Hook: session:compact:before — finalize current flow trace before compaction
// ---------------------------------------------------------------------------

async function handleSessionCompactBefore(event: InternalHookEvent): Promise<void> {
  const entry = getBuilder(event.sessionKey);
  if (!entry) {
    return;
  }

  await finalizeBuilder(entry.builder, "completed");
  removeBuilder(event.sessionKey);
}

// ---------------------------------------------------------------------------
// Public API: wrap onToolResult to capture tool outcomes
// ---------------------------------------------------------------------------

export type MetaHarnessToolResultInfo = {
  toolName?: string;
  success?: boolean;
  error?: string;
  durationMs?: number;
};

/**
 * Creates an onToolResult wrapper that records tool outcomes to the active flow trace.
 *
 * Usage in dispatch-from-config.ts:
 * ```ts
 * import { wrapMetaHarnessOnToolResult } from "../meta-harness/hooks.js";
 *
 * onToolResult: wrapMetaHarnessOnToolResult(sessionKey, workspaceDir, existingOnToolResult)
 * ```
 */
export function wrapMetaHarnessOnToolResult(
  sessionKey: string,
  workspaceDir: string,
  existingOnToolResult?: (
    payload: import("../auto-reply/types.js").ReplyPayload,
  ) => Promise<void> | void,
  toolInfo?: MetaHarnessToolResultInfo,
): (payload: import("../auto-reply/types.js").ReplyPayload) => Promise<void> {
  return async (payload) => {
    // Record tool outcome (fire-and-forget, never blocks main path)
    recordToolOutcome(sessionKey, workspaceDir, toolInfo).catch(() => {});

    // Call the original handler
    await existingOnToolResult?.(payload);
  };
}

async function recordToolOutcome(
  sessionKey: string,
  workspaceDir: string,
  toolInfo?: MetaHarnessToolResultInfo,
): Promise<void> {
  const entry = getBuilder(sessionKey);
  if (!entry) {
    return;
  }

  const gating = await checkWorkspaceGating(workspaceDir);
  if (!gating.enabled) {
    return;
  }

  const outcome: ToolOutcome = {
    tool_name: toolInfo?.toolName ?? "unknown",
    success: toolInfo?.success ?? true,
    duration_ms: toolInfo?.durationMs ?? 0,
  };
  if (toolInfo?.error) {
    outcome.error = toolInfo.error;
  }

  entry.builder.recordToolOutcome(outcome);
}

// ---------------------------------------------------------------------------
// Public API: finalize a session flow trace (call after reply completes)
// ---------------------------------------------------------------------------

export async function finalizeSessionFlowTrace(
  sessionKey: string,
  workspaceDir: string,
  outcome: RunOutcome,
): Promise<void> {
  const entry = getBuilder(sessionKey);
  if (!entry) {
    return;
  }

  await finalizeBuilder(entry.builder, outcome);
  removeBuilder(sessionKey);
}

// ---------------------------------------------------------------------------
// Public API: record a delegation (call after sessions_spawn)
// ---------------------------------------------------------------------------

export async function recordDelegation(params: {
  sessionKey: string;
  workspaceDir: string;
  childSessionId: string;
  agentType: string;
  taskBrief: string;
  status: "completed" | "failed" | "escalated";
}): Promise<void> {
  const entry = getBuilder(params.sessionKey);
  if (!entry) {
    return;
  }

  const gating = await checkWorkspaceGating(params.workspaceDir);
  if (!gating.enabled) {
    return;
  }

  entry.builder.recordDelegation({
    child_trace_id: params.childSessionId,
    agent_type: params.agentType,
    task_brief: params.taskBrief,
    status: params.status,
  });
}

// ---------------------------------------------------------------------------
// Public API: start heartbeat flow trace
// ---------------------------------------------------------------------------

export function startHeartbeatFlowTrace(
  sessionKey: string,
  workspaceDir: string,
  reason?: string,
): ActiveBuilder | undefined {
  const trigger: TriggerKind = reason === "cron" || reason === "exec-event" ? "cron" : "heartbeat";

  const builder = startFlowTrace({
    sessionKey,
    workspaceDir,
    trigger,
    taskSummary: `heartbeat run (${reason ?? "interval"})`,
  });
  if (!builder) {
    return undefined;
  }
  return getBuilder(sessionKey);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

/**
 * Register meta-harness hook handlers.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function registerMetaHarnessHooks(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerInternalHook("gateway:startup", handleGatewayStartup);
  registerInternalHook("message:received", handleMessageReceived);
  registerInternalHook("session:compact:before", handleSessionCompactBefore);

  log.debug("meta-harness hooks registered");
}

/**
 * Reset meta-harness state (for testing only).
 */
export function resetMetaHarnessState(): void {
  registered = false;
  defaultWorkspaceDir = null;
  activeBuilders.clear();
}
