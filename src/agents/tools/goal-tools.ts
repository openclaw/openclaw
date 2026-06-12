/**
 * Model-facing thread goal tools.
 *
 * Provides create/get/clear/update goal operations scoped to the current
 * session store. All persistent state lives in the canonical session
 * store (the same JSON file as the rest of the session state) — there
 * is no sidecar archive file.
 */
import { Type } from "typebox";
import {
  ClearGoalRejectedError,
  CLEARABLE_GOAL_STATUSES,
  clearAndArchiveSessionGoal,
  createSessionGoal,
  getSessionGoal,
  MODEL_UPDATABLE_SESSION_GOAL_STATUSES,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

type GoalToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
  /**
   * Max retained cleared goals per session. Defaults to 50.
   * Configurable per-call by the operator; mirrors
   * `clearAndArchiveSessionGoal`'s `clearRetained` option.
   */
  clearedGoalsRetained?: number;
};

type GoalSessionScope = {
  sessionKey: string;
  storePath: string;
};

const CreateGoalToolSchema = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue. Create only when explicitly requested.",
  }),
  token_budget: Type.Optional(
    Type.Number({
      description: "Optional positive token budget for this goal.",
    }),
  ),
});

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(MODEL_UPDATABLE_SESSION_GOAL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
});

const ClearGoalToolSchema = Type.Object({
  note: Type.Optional(
    Type.String({
      description:
        "Optional free-form note attached to the cleared-goal archive entry (e.g. why the goal was cleared).",
    }),
  ),
});

const CLEARABLE_STATUS_DESCRIPTION = Array.from(CLEARABLE_GOAL_STATUSES).join(", ");

function resolveGoalSessionScope(options: GoalToolOptions): GoalSessionScope {
  const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const parsedSessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const parsedAgentSessionAgentId = parseAgentSessionKey(options.agentSessionKey)?.agentId;
  // Prefer the run session's agent id; fall back to the agent session for legacy tool contexts.
  const agentId = normalizeAgentId(
    parsedSessionAgentId ?? parsedAgentSessionAgentId ?? options.sessionAgentId,
  );
  return {
    sessionKey,
    storePath: resolveStorePath(options.config?.session?.store, {
      agentId,
    }),
  };
}

/** Creates the read-only tool that returns the current thread goal snapshot. */
export function createGetGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Get Goal",
    name: "get_goal",
    displaySummary: "Get the current thread goal",
    description: "Get the current goal for this thread, including status and token usage.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = await getSessionGoal({
        ...resolveGoalSessionScope(options),
        persist: false,
      });
      return jsonResult(snapshot);
    },
  };
}

/**
 * Creates the tool that starts a new thread goal when explicitly requested.
 *
 * Behavioral contract (v02): `create_goal` ALWAYS blocks on any existing
 * goal, including terminal ones. To rotate a terminal goal, the model
 * must first call `clear_goal`. This preserves the documented lifecycle
 * (single goal per session, explicit operator-style clearing) and removes
 * the silent auto-replace behavior that v01 introduced.
 */
export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Create Goal",
    name: "create_goal",
    displaySummary: "Create a thread goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. If a goal already exists in any state, creation fails with an error pointing at clear_goal. The model must clear the existing goal first (and only terminal goals can be cleared) before creating a new one in the same session.",
    parameters: CreateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const objective = readStringParam(params, "objective", { required: true });
      const tokenBudget = readNumberParam(params, "token_budget", { integer: true });
      if (tokenBudget !== undefined && tokenBudget <= 0) {
        // Budgets are positive limits; zero would immediately make accounting ambiguous.
        throw new ToolInputError("token_budget must be positive");
      }
      const scope = resolveGoalSessionScope(options);

      // Pre-flight: surface a clear, actionable error if a goal already exists.
      // The previous auto-archive behavior is intentionally removed (v02 contract).
      const existing = await getSessionGoal({ ...scope, persist: false });
      if (existing.status === "found" && existing.goal) {
        if (CLEARABLE_GOAL_STATUSES.has(existing.goal.status)) {
          throw new ToolInputError(
            `a goal already exists for this session (status: ${existing.goal.status}). ` +
              `Call clear_goal first to archive and remove it, then retry create_goal.`,
          );
        }
        throw new ToolInputError(
          `a goal already exists for this session in status '${existing.goal.status}'. ` +
            `Active goals can only be cleared by the operator/session control.`,
        );
      }

      const goal = await createSessionGoal({
        ...scope,
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      });
      return jsonResult({ status: "created", goal });
    },
  };
}

/**
 * Creates the tool that clears (and atomically archives) the current goal.
 *
 * Behavioral contract (v02):
 * - Only terminal/clearable states are allowed (complete, blocked, paused,
 *   usage_limited, budget_limited). Active goals are rejected.
 * - The cleared goal is appended to `clearedGoals` on the session entry in
 *   the same atomic write that removes it from `goal`. No sidecar file.
 * - If the atomic transition fails, the goal is NOT cleared and the
 *   error propagates to the caller.
 */
export function createClearGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Clear Goal",
    name: "clear_goal",
    displaySummary: "Clear (atomically archive) the current thread goal",
    description:
      `Clear the current session goal. Only goals in a clearable state can be cleared: ${CLEARABLE_STATUS_DESCRIPTION}. ` +
      `Active goals are rejected to preserve the documented lifecycle contract. ` +
      `On success, the cleared goal is atomically appended to the session's clearedGoals history (no sidecar file). ` +
      `After clearing, a new goal can be created with create_goal. ` +
      `Use this to reset a stuck terminal state, or to manually rotate a paused/blocked goal.`,
    parameters: ClearGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const note = typeof params.note === "string" ? params.note : undefined;
      const scope = resolveGoalSessionScope(options);
      try {
        const result = await clearAndArchiveSessionGoal({
          ...scope,
          ...(note ? { note } : {}),
          ...(options.clearedGoalsRetained !== undefined
            ? { clearRetained: options.clearedGoalsRetained }
            : {}),
          rejectNonClearable: true,
        });
        if (!result.wasCleared) {
          return jsonResult({ status: "no-op", reason: "no goal to clear" });
        }
        return jsonResult({
          status: "cleared",
          cleared: result.cleared,
        });
      } catch (err) {
        if (err instanceof ClearGoalRejectedError) {
          throw new ToolInputError(
            `clear_goal rejected: current goal status is '${err.currentStatus}'. ` +
              `Only ${CLEARABLE_STATUS_DESCRIPTION} can be cleared. Active goals must be ` +
              `completed, blocked, paused, usage_limited, or budget_limited before clear_goal will accept them.`,
          );
        }
        throw err;
      }
    },
  };
}

/** Creates the tool that marks the current thread goal complete or blocked. */
export function createUpdateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Update Goal",
    name: "update_goal",
    displaySummary: "Complete or block a thread goal",
    description:
      "Mark the current goal complete only when achieved, or blocked only after the same blocking condition recurs for at least three consecutive goal turns. Do not use blocked for ordinary difficulty or missing polish.",
    parameters: UpdateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const status = readStringParam(params, "status", { required: true });
      if (
        !MODEL_UPDATABLE_SESSION_GOAL_STATUSES.includes(
          status as (typeof MODEL_UPDATABLE_SESSION_GOAL_STATUSES)[number],
        )
      ) {
        throw new ToolInputError(
          `status must be one of ${MODEL_UPDATABLE_SESSION_GOAL_STATUSES.join(", ")}`,
        );
      }
      const note = readStringParam(params, "note");
      const goal = await updateSessionGoalStatus({
        ...resolveGoalSessionScope(options),
        status: status as (typeof MODEL_UPDATABLE_SESSION_GOAL_STATUSES)[number],
        ...(note ? { note } : {}),
      });
      return jsonResult({ status: "updated", goal });
    },
  };
}
