import { Type } from "@sinclair/typebox";
import {
  describeEnterPlanModeTool,
  ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool } from "./common.js";

/**
 * `enter_plan_mode` agent tool — flips the session into plan mode so the
 * runtime mutation gate (src/agents/plan-mode/mutation-gate.ts) starts
 * blocking write/edit/exec/etc. Read-only tools remain available.
 *
 * The actual session-state transition happens server-side in the
 * sessions.patch handler — this tool is the agent-visible affordance
 * that triggers the patch via the embedded runner. The tool body
 * intentionally has no side effects beyond returning a structured
 * result; the runner (src/agents/pi-embedded-runner/run.ts) inspects
 * the tool call name and applies the session-state change.
 *
 * This split keeps the tool implementation cheap and testable while
 * letting the runtime own the session-state contract.
 */

const EnterPlanModeToolSchema = Type.Object(
  {
    reason: Type.Optional(
      Type.String({
        description:
          "Optional short justification shown alongside the mode-entered event " +
          "(e.g. 'multi-file refactor — surface the plan first').",
      }),
    ),
  },
  // Copilot review #68939 (2026-04-19): forbid additional properties
  // for consistency with `plan_mode_status` and the post-third-wave
  // schema-hardening direction.
  { additionalProperties: false },
);

export interface CreateEnterPlanModeToolOptions {
  /** Stable run identifier used by the runner to scope mode-entered events. */
  runId?: string;
}

export function createEnterPlanModeTool(_options?: CreateEnterPlanModeToolOptions): AnyAgentTool {
  return {
    label: "Enter Plan Mode",
    name: "enter_plan_mode",
    displaySummary: ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
    description: describeEnterPlanModeTool(),
    parameters: EnterPlanModeToolSchema,
    execute: async (_toolCallId, args, _signal) => {
      const params = args as Record<string, unknown>;
      const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
      // Tool result content matters: returning an empty body lets the
      // model treat the tool call as the entire turn and stop. The
      // text below tells the agent — visibly in the tool result — that
      // entering plan mode is just step 1 and exit_plan_mode is the
      // next required action. Without this nudge agents commonly
      // respond with "I'm opening a fresh plan cycle" then halt.
      const text = [
        "Plan mode is now active.",
        "Next required step: investigate read-only if needed (read, web_search, web_fetch), then call `exit_plan_mode` with the proposed plan.",
        "Do NOT stop after this tool call — the plan has not been submitted yet.",
        "Do NOT respond with the plan as chat text — it must go through `exit_plan_mode` so the user gets Approve/Reject buttons.",
      ].join(" ");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "entered" as const,
          mode: "plan" as const,
          ...(reason && reason.length > 0 ? { reason } : {}),
        },
      };
    },
  };
}
