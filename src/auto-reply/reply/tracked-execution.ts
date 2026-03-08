/**
 * Tracked Execution Router
 *
 * Routes execution intent requests to the tracked orchestrator runtime
 * instead of the main agent.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawnSubagentDirect, type SpawnSubagentContext } from "../../agents/subagent-spawn.js";
import { UserIntentType, type IntentAnalysisResult } from "../../channels/smart-debounce.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

/**
 * Get the path to the task follow-ups directory
 */
function getTaskFollowupsDirectory(): string {
  return join(os.homedir(), ".openclaw", "sentinel", "task-followups");
}

export interface TrackedExecutionOptions {
  ctx: MsgContext;
  intentResult: IntentAnalysisResult;
  cfg: OpenClawConfig;
  agentId: string;
  agentSessionKey?: string;
  workspaceDir?: string;
}

/**
 * Check if we should route to tracked execution
 */
export function shouldRouteToTrackedExecution(intentResult: IntentAnalysisResult): boolean {
  return (
    intentResult.input_finalized &&
    intentResult.intent_type === UserIntentType.EXECUTION &&
    intentResult.execution_required
  );
}

/**
 * Check for pending follow-ups
 */
export async function checkForPendingFollowups(): Promise<boolean> {
  const followupsDir = getTaskFollowupsDirectory();

  try {
    // Check if the follow-ups directory exists
    await fs.access(followupsDir);

    // List all files in the follow-ups directory
    const files = await fs.readdir(followupsDir);

    // Filter out system files and check if there are any follow-up files
    const pendingFollowups = files.filter(
      (file) => !file.startsWith(".") && file.trim().length > 0,
    );

    return pendingFollowups.length > 0;
  } catch {
    // If the directory doesn't exist or we can't read it, assume no follow-ups
    return false;
  }
}

/**
 * Get the next pending follow-up
 */
export async function getNextFollowup(): Promise<string | null> {
  const followupsDir = getTaskFollowupsDirectory();

  try {
    const files = await fs.readdir(followupsDir);
    const pendingFollowups = files.filter(
      (file) => !file.startsWith(".") && file.trim().length > 0,
    );

    if (pendingFollowups.length > 0) {
      // Get the first follow-up file
      const followupFile = join(followupsDir, pendingFollowups[0]);

      // Read the content of the follow-up file
      const content = await fs.readFile(followupFile, "utf8");

      return content.trim();
    }
  } catch {
    // If there's an error reading, return null
  }

  return null;
}

/**
 * Route an execution intent request to the tracked orchestrator
 */
export async function routeToTrackedExecution(
  options: TrackedExecutionOptions,
): Promise<{ status: "routed"; note?: string } | { status: "fallback"; reason: string }> {
  const { ctx, intentResult, agentId, agentSessionKey, workspaceDir } = options;

  if (!shouldRouteToTrackedExecution(intentResult)) {
    return {
      status: "fallback",
      reason: "not an execution intent request",
    };
  }

  // Check if there are pending follow-ups before starting a new execution
  const hasPendingFollowups = await checkForPendingFollowups();
  if (hasPendingFollowups) {
    return {
      status: "fallback",
      reason: "pending follow-ups exist",
    };
  }

  const messageText = ctx.BodyForAgent ?? ctx.Body ?? "";

  // Build the context for spawning the subagent
  const spawnContext: SpawnSubagentContext = {
    agentSessionKey,
    agentChannel: ctx.OriginatingChannel ?? undefined,
    agentAccountId: ctx.AccountId,
    agentTo: ctx.OriginatingTo ?? undefined,
    agentThreadId: ctx.MessageThreadId,
    workspaceDir,
  };

  // Spawn a tracked subagent for execution
  const result = await spawnSubagentDirect(
    {
      task: messageText,
      label: "Tracked Execution",
      agentId,
      mode: "session", // Use persistent session for tracked execution
      cleanup: "keep",
      expectsCompletionMessage: true,
    },
    spawnContext,
  );

  if (result.status === "accepted") {
    return {
      status: "routed",
      note: result.note,
    };
  }

  // If spawn failed, fallback to main agent
  return {
    status: "fallback",
    reason: result.error ?? "failed to spawn tracked execution",
  };
}
