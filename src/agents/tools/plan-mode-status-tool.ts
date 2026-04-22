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
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isPlanModeDebugEnabled } from "../plan-mode/plan-mode-debug-log.js";
import {
  describePlanModeStatusTool,
  PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool } from "./common.js";

// Copilot review #68939 (2026-04-19): explicitly forbid additional
// properties — the tool ignores args entirely, so accepting any
// payload is unnecessary and complicates downstream validation /
// telemetry. `additionalProperties: false` makes the rejection
// explicit at schema-validation time.
const PlanModeStatusToolSchema = Type.Object({}, { additionalProperties: false });

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
      //
      // Copilot review #68939 (2026-04-19): track read success/
      // failure explicitly (`sessionStoreReadOk`) so the tool's
      // human summary can distinguish a true "not in plan mode"
      // from a "we couldn't read disk to find out" case. Pre-fix,
      // both collapsed to "Not in plan mode…" and operators
      // debugging stuck sessions had no signal that the disk read
      // failed.
      let entry: SessionEntry | undefined;
      let sessionStoreReadOk = true;
      let sessionStoreReadError: string | undefined;
      if (storePath && sessionKey) {
        try {
          const liveStore = loadSessionStore(storePath, { skipCache: true });
          entry = liveStore?.[sessionKey];
        } catch (err) {
          sessionStoreReadOk = false;
          sessionStoreReadError = err instanceof Error ? err.message : String(err);
        }
      } else {
        // Copilot review #68939 (round-1): when storePath or
        // sessionKey is missing, the disk read can't even be
        // attempted — treat that as "unknown state", not "not in
        // plan mode". Pre-fix, the read was skipped silently and
        // the human summary defaulted to "Not in plan mode…",
        // misleading operators about what happened.
        sessionStoreReadOk = false;
        sessionStoreReadError = `missing ${!storePath ? "storePath" : ""}${!storePath && !sessionKey ? "/" : ""}${!sessionKey ? "sessionKey" : ""}`;
      }

      // openSubagentRunIds lives in-memory on the AgentRunContext —
      // not on disk — so we read it via getAgentRunContext.
      const ctx = runId ? getAgentRunContext(runId) : undefined;
      const openSubagentRunIds = ctx?.openSubagentRunIds ? [...ctx.openSubagentRunIds] : [];

      // Copilot review #68939 (2026-04-19): use the shared
      // `isPlanModeDebugEnabled` helper from `plan-mode-debug-log.ts`
      // instead of duplicating the env-wins-over-config logic.
      const debugLogEnabled = isPlanModeDebugEnabled();

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
        // Copilot review #68939 (2026-04-19): expose disk-read
        // success/failure to programmatic consumers (e.g. /plan
        // self-test) so a missing entry can be classified as
        // "session truly absent" vs "disk read failed".
        sessionStoreReadOk,
        ...(sessionStoreReadError ? { sessionStoreReadError } : {}),
      };

      // Tool result text: a compact human-readable summary (1-3
      // sentences) so the agent can absorb the state without
      // parsing the full JSON. The `details` object carries the
      // structured snapshot for programmatic consumers (e.g.
      // /plan self-test).
      //
      // Copilot review #68939 (2026-04-19): when the disk read
      // failed, surface the unknown-state case in the summary
      // instead of pretending we know "not in plan mode" — that
      // misleads operators debugging stuck sessions.
      const summary = !sessionStoreReadOk
        ? `WARNING: session-store read failed (${sessionStoreReadError ?? "unknown error"}); plan-mode state is UNKNOWN. The agent should treat this as a transient diagnostic failure, not a confirmed "normal" state.`
        : inPlanMode
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
