/**
 * Model-facing thread goal tools.
 *
 * Provides create/get/update goal operations scoped to the current session store.
 */
import { Type } from "typebox";
import {
  createSessionGoal,
  getSessionGoal,
  MODEL_UPDATABLE_SESSION_GOAL_STATUSES,
  setSessionGoalWaitBarrier,
  updateSessionGoalContract,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionGoalContract } from "../../config/sessions/types.js";
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
};

type GoalSessionScope = {
  sessionKey: string;
  storePath: string;
};

// Shared optional completion-contract fields. Present on both create_goal and
// set_goal_contract so a contract can be supplied up front or attached later.
const ContractToolFields = {
  outcome: Type.Optional(
    Type.String({ description: "Completion contract: what 'done' concretely means." }),
  ),
  verification: Type.Optional(
    Type.String({
      description: "Completion contract: how completion is proven (e.g. a test command / state).",
    }),
  ),
  constraints: Type.Optional(
    Type.Array(Type.String(), {
      description: "Completion contract: invariants that must not regress.",
    }),
  ),
  boundaries: Type.Optional(
    Type.Array(Type.String(), {
      description: "Completion contract: in-scope tools / paths / surfaces.",
    }),
  ),
  stop_when: Type.Optional(
    Type.String({
      description: "Completion contract: condition to stop and ask the user instead of continuing.",
    }),
  ),
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
  ...ContractToolFields,
});

const SetGoalContractToolSchema = Type.Object({ ...ContractToolFields });

const SetGoalWaitToolSchema = Type.Object({
  seconds: Type.Optional(
    Type.Number({
      description:
        "Park the goal for this many seconds (a time backoff). Ignored when session_key is set.",
    }),
  ),
  session_key: Type.Optional(
    Type.String({
      description: "Park the goal until this session key's run finishes.",
    }),
  ),
  reason: Type.Optional(Type.String({ description: "Short reason the goal is parked." })),
});

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(MODEL_UPDATABLE_SESSION_GOAL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
});

function readStringListParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolInputError(`${key} must be an array of strings`);
  }
  const items = (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Extracts the optional completion-contract fields from tool params. */
function readContractFromParams(params: Record<string, unknown>): SessionGoalContract {
  const contract: SessionGoalContract = {};
  const outcome = readStringParam(params, "outcome");
  const verification = readStringParam(params, "verification");
  const stopWhen = readStringParam(params, "stop_when");
  const constraints = readStringListParam(params, "constraints");
  const boundaries = readStringListParam(params, "boundaries");
  if (outcome) contract.outcome = outcome;
  if (verification) contract.verification = verification;
  if (constraints) contract.constraints = constraints;
  if (boundaries) contract.boundaries = boundaries;
  if (stopWhen) contract.stopWhen = stopWhen;
  return contract;
}

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

/** Creates the tool that starts a new thread goal when explicitly requested. */
export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Create Goal",
    name: "create_goal",
    displaySummary: "Create a thread goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. Fails if a goal already exists; use user-facing goal controls to clear it.",
    parameters: CreateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const objective = readStringParam(params, "objective", { required: true });
      const tokenBudget = readNumberParam(params, "token_budget", { integer: true });
      if (tokenBudget !== undefined && tokenBudget <= 0) {
        // Budgets are positive limits; zero would immediately make accounting ambiguous.
        throw new ToolInputError("token_budget must be positive");
      }
      const contract = readContractFromParams(params);
      const goal = await createSessionGoal({
        ...resolveGoalSessionScope(options),
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(Object.keys(contract).length > 0 ? { contract } : {}),
      });
      return jsonResult({ status: "created", goal });
    },
  };
}

/** Creates the tool that attaches or replaces the completion contract on a goal. */
export function createSetGoalContractTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Set Goal Contract",
    name: "set_goal_contract",
    displaySummary: "Set the completion contract for a thread goal",
    description:
      "Attach or replace the completion contract (outcome, verification, constraints, boundaries, stop-when) on the current goal so every continuation restates it. Pass no fields to clear the contract. Fails when no goal exists.",
    parameters: SetGoalContractToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const contract = readContractFromParams(params);
      const goal = await updateSessionGoalContract({
        ...resolveGoalSessionScope(options),
        contract: Object.keys(contract).length > 0 ? contract : undefined,
      });
      return jsonResult({ status: "updated", goal });
    },
  };
}

/** Creates the tool that parks the current goal behind a wait barrier. */
export function createSetGoalWaitTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Set Goal Wait",
    name: "set_goal_wait",
    displaySummary: "Park a thread goal on a wait barrier",
    description:
      "Park the active goal while blocked on async work so the goal driver stops firing continuations until the barrier clears. Provide seconds (a time backoff) OR session_key (wait for that session's run to finish). The barrier auto-clears once satisfied. Fails when no active goal exists.",
    parameters: SetGoalWaitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "session_key");
      const seconds = readNumberParam(params, "seconds");
      const reason = readStringParam(params, "reason");
      if (!sessionKey && (seconds === undefined || seconds <= 0)) {
        throw new ToolInputError("provide session_key or a positive seconds value");
      }
      const goal = await setSessionGoalWaitBarrier({
        ...resolveGoalSessionScope(options),
        ...(sessionKey ? { waitingOnSessionKey: sessionKey } : {}),
        ...(!sessionKey && seconds !== undefined
          ? { waitingUntil: Date.now() + Math.floor(seconds) * 1000 }
          : {}),
        ...(reason ? { reason } : {}),
      });
      if (!goal) {
        throw new ToolInputError("no active goal to park");
      }
      return jsonResult({ status: "waiting", goal });
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
