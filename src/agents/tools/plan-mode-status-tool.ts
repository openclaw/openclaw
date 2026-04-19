/**
 * `plan_mode_status` agent tool — read-only introspection of the
 * current plan-mode lifecycle state.
 *
 * # Why this exists (iter-3 D6)
 *
 * Without this, an agent debugging a stuck plan-mode session has to
 * INFER state from tool errors ("update_plan rejected → I must not
 * be in plan mode anymore") or wait for the runtime to inject a
 * `[PLAN_DECISION]:` synthetic message. Neither path is reliable
 * for self-diagnosis.
 *
 * `plan_mode_status` returns a structured snapshot the agent can
 * inspect directly:
 *   - is plan mode active?
 *   - is there a pending approval, and what's its title?
 *   - how many subagents are in flight (would block exit_plan_mode)?
 *   - is the plan-mode debug log currently enabled?
 *   - was the [PLAN_MODE_INTRO]: one-shot delivered yet?
 *
 * Used by:
 *   - The agent itself when asked "what's my plan-mode state?" or
 *     "why was my tool blocked?"
 *   - The `/plan self-test` slash command (D5) to verify state
 *     transitions during the synthetic test flow
 *   - Future debugging skills + workflows
 *
 * # Read-only contract
 *
 * This tool ONLY reads state; it never mutates. Safe to call at
 * any point in any session, including during a pending approval.
 * No side effects on the [PLAN_MODE_INTRO]: one-shot, the
 * pendingAgentInjection consumer, or any other state.
 */
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/io.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  describePlanModeStatusTool,
  PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool } from "./common.js";

const PlanModeStatusToolSchema = Type.Object({});

export interface CreatePlanModeStatusToolOptions {
  /** Stable run identifier used to look up the in-memory AgentRunContext for openSubagentRunIds. */
  runId?: string;
  /** Session key used to look up persisted plan-mode state on disk. */
  sessionKey?: string;
  /** Storage path used by `loadSessionStore` to read the live session entry. */
  storePath?: string;
}

export function createPlanModeStatusTool(options?: CreatePlanModeStatusToolOptions): AnyAgentTool {
  return {
    label: "Plan Mode Status",
    name: "plan_mode_status",
    displaySummary: PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describePlanModeStatusTool(),
    parameters: PlanModeStatusToolSchema,
    execute: async (_toolCallId, _args, _signal) => {
      const runId = options?.runId;
      const sessionKey = options?.sessionKey;
      // Resolve storePath either from explicit option (test path) or
      // from the default location for the session's agent. Lets the
      // tool work without storePath plumbing through the registry.
      let storePath = options?.storePath;
      if (!storePath && sessionKey) {
        const parsed = parseAgentSessionKey(sessionKey);
        storePath = resolveDefaultSessionStorePath(parsed?.agentId);
      }

      // Read the live session entry from disk (bypassing the cache)
      // so we get the freshest plan-mode state — same `skipCache: true`
      // pattern used by `resolveLatestPlanModeFromDisk` for the
      // mutation-gate freshness contract (iter-2 Bug A).
      let entry: SessionEntry | undefined;
      if (storePath && sessionKey) {
        try {
          const liveStore = loadSessionStore(storePath, { skipCache: true });
          entry = liveStore?.[sessionKey];
        } catch {
          // Fall through; entry stays undefined and we report the
          // `inPlanMode: false` default with a warning suffix.
        }
      }

      // openSubagentRunIds lives in-memory on the AgentRunContext —
      // not on disk — so we read it via getAgentRunContext.
      const ctx = runId ? getAgentRunContext(runId) : undefined;
      const openSubagentRunIds = ctx?.openSubagentRunIds ? [...ctx.openSubagentRunIds] : [];

      // Debug-flag resolution mirrors plan-mode-debug-log.ts (env
      // wins over config).
      const debugLogEnabled = (() => {
        if (process.env.OPENCLAW_DEBUG_PLAN_MODE === "1") {
          return true;
        }
        try {
          const cfg = loadConfig();
          return cfg?.agents?.defaults?.planMode?.debug === true;
        } catch {
          return false;
        }
      })();

      const planMode = entry?.planMode;
      const inPlanMode = planMode?.mode === "plan";
      const status = {
        inPlanMode,
        approval: planMode?.approval,
        title: planMode?.title,
        approvalRunId: planMode?.approvalRunId,
        planStepCount: planMode?.lastPlanSteps?.length ?? 0,
        openSubagentCount: openSubagentRunIds.length,
        openSubagentRunIds: openSubagentRunIds.slice(0, 10),
        recentlyApprovedAt: entry?.recentlyApprovedAt,
        pendingAgentInjectionPreview: entry?.pendingAgentInjection
          ? entry.pendingAgentInjection.slice(0, 200)
          : undefined,
        planModeIntroDeliveredAt: entry?.planModeIntroDeliveredAt,
        autoApprove: planMode?.autoApprove,
        debugLogEnabled,
        sessionKey,
        runId,
      };

      // Tool result text: a compact human-readable summary (1-3
      // sentences) so the agent can absorb the state without
      // parsing the full JSON. The `details` object carries the
      // structured snapshot for programmatic consumers (e.g.
      // /plan self-test).
      const summary = inPlanMode
        ? `In plan mode (approval=${planMode?.approval ?? "none"}; title="${planMode?.title ?? "(unset)"}"; ${openSubagentRunIds.length} subagent(s) in flight; ${planMode?.lastPlanSteps?.length ?? 0} plan step(s) tracked).`
        : `Not in plan mode (mode=${planMode?.mode ?? "normal"}; ${entry?.recentlyApprovedAt ? `recently approved at ${new Date(entry.recentlyApprovedAt).toISOString()}` : "no recent approval"}).`;
      const debugSuffix = debugLogEnabled
        ? " Plan-mode debug log is ENABLED — tail with: tail -F ~/.openclaw/logs/gateway.err.log | grep '\\[plan-mode/'"
        : " Plan-mode debug log is DISABLED — enable with: openclaw config set agents.defaults.planMode.debug true";
      const text = `${summary}${debugSuffix}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "ok" as const,
          ...status,
        },
      };
    },
  };
}
