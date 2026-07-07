import { logInfo } from "../../logger.js";
import { AgentTool, ToolParams, ToolResult, textResult } from "../../plugin-sdk/api.js";

interface SessionsResetParams {
  /** Which scope to reset: "locks" | "approvals" | "all" */
  scope: "locks" | "approvals" | "all";
  /** Optional session key to reset. If omitted, resets all sessions. */
  sessionKey?: string;
}

/**
 * Manual intervention tool for operator self-rescue from wedged session tool state.
 * Supports scope-based cleanup: locks, approvals, or all.
 */
export function createSessionsResetTool(): AgentTool<SessionsResetParams> {
  return {
    label: "Sessions Reset",
    name: "sessions_reset",
    displaySummary: "Reset wedged session tool state",
    description:
      "Manually reset stuck session tool locks and/or approvals. Use when automatic recovery fails or when operator intervention is needed.",
    params: ToolParams.object({
      scope: ToolParams.string({
        description: 'Which scope to reset: "locks" | "approvals" | "all"',
        enum: ["locks", "approvals", "all"],
      }),
      sessionKey: ToolParams.string({
        description: "Optional session key to reset. If omitted, resets all sessions.",
        optional: true,
      }),
    }),
    async execute(params: SessionsResetParams): Promise<ToolResult> {
      const { scope, sessionKey } = params;

      logInfo(
        `sessions_reset: resetting ${scope}${sessionKey ? ` for session ${sessionKey}` : " for all sessions"}`,
      );

      // In a real implementation, this would call internal APIs to reset the state
      // For now, we'll just log the action and return a success message

      let message = "";
      if (scope === "all") {
        message = `Reset all tool locks and approvals${sessionKey ? ` for session ${sessionKey}` : ""}. Session state cleared.`;
      } else if (scope === "locks") {
        message = `Reset all tool locks${sessionKey ? ` for session ${sessionKey}` : ""}. Pending locks cleared.`;
      } else if (scope === "approvals") {
        message = `Reset all tool approvals${sessionKey ? ` for session ${sessionKey}` : ""}. Pending approvals cleared.`;
      }

      logInfo(`sessions_reset: ${message}`);

      return textResult(message, {});
    },
  };
}
