/**
 * Model-facing thread goal tools.
 *
 * Provides create/get/update goal operations scoped to the current session store.
 */
import { Type } from "typebox";
import os from "node:os";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import {
  createSessionGoal,
  getSessionGoal,
  clearSessionGoal,
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
  /** Resolved workspace dir; used to locate the goal-archive log. */
  workspaceDir?: string;
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

// Goals in any of these states can be replaced by a new create_goal call.
// Mirrors the non-active states listed in resolveGoalCommandHint() in goals.ts.
const GOAL_TERMINAL_STATUSES = new Set([
  "complete",
  "blocked",
  "paused",
  "usage_limited",
  "budget_limited",
]);

function resolveGoalArchiveWorkspace(
  options: GoalToolOptions,
  config?: OpenClawConfig,
): string {
  // Prefer the workspaceDir that openclaw-tools.ts already resolved; fall back
  // to the agent's configured workspace, then the env var, then ~/.openclaw/workspace.
  if (options.workspaceDir) return options.workspaceDir;
  const configured = (() => {
    try {
      return config?.agents?.defaults?.workspace;
    } catch {
      return undefined;
    }
  })();
  if (configured) return configured;
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function archiveReplacedGoal(
  workspaceDir: string,
  sessionKey: string,
  archivedGoal: { [k: string]: unknown },
  note?: string,
): void {
  // Best-effort: archive failures must not block goal replacement.
  try {
    const logDir = path.join(workspaceDir, "memory");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "goal-archive.jsonl");
    const record = {
      sessionKey,
      archivedAt: Date.now(),
      id: archivedGoal.id,
      objective: archivedGoal.objective,
      status: archivedGoal.status,
      createdAt: archivedGoal.createdAt,
      updatedAt: archivedGoal.updatedAt,
      completedAt: archivedGoal.completedAt ?? null,
      blockedAt: archivedGoal.blockedAt ?? null,
      tokensUsed: archivedGoal.tokensUsed ?? 0,
      tokenBudget: archivedGoal.tokenBudget,
      lastStatusNote: archivedGoal.lastStatusNote ?? null,
      clearNote: note ?? null,
      resumable: archivedGoal.status === "paused",
    };
    appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // intentionally swallowed
  }
}

const ClearGoalToolSchema = Type.Object({
  archive: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), append the existing goal to memory/goal-archive.jsonl before clearing. If false, clear without archiving.",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Optional free-form note to append to the archive entry (e.g. why the goal was cleared).",
    }),
  ),
});

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
      "Create a goal only when explicitly requested by the user or system instructions. If a goal already exists in a terminal state (complete, blocked, paused, usage_limited, budget_limited), it is archived to memory/goal-archive.jsonl and replaced. An active goal still blocks creation.",
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

      // Auto-archive + clear any existing terminal goal before creating the new one.
      // Active goals still block (existing behavior), protecting in-flight work.
      const existing = await getSessionGoal({ ...scope, persist: false });
      if (
        existing.status === "found" &&
        existing.goal &&
        GOAL_TERMINAL_STATUSES.has(existing.goal.status)
      ) {
        const workspaceDir = resolveGoalArchiveWorkspace(options, options.config);
        archiveReplacedGoal(workspaceDir, scope.sessionKey, existing.goal);
        await clearSessionGoal(scope);
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

/** Creates the tool that clears the current session goal (with optional archive). */
export function createClearGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Clear Goal",
    name: "clear_goal",
    displaySummary: "Clear (archive) the current session goal",
    description:
      "Clear the current session goal. If a goal exists, it is archived to memory/goal-archive.jsonl by default (set archive=false to skip). After clearing, a new goal can be created with create_goal. Use this to reset a stuck state or to manually rotate goals without completing them first.",
    parameters: ClearGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const archive = params.archive !== false;
      const note = typeof params.note === "string" ? params.note : undefined;
      const scope = resolveGoalSessionScope(options);
      const existing = await getSessionGoal({ ...scope, persist: false });
      if (existing.status === "found" && existing.goal && archive) {
        const workspaceDir = resolveGoalArchiveWorkspace(options, options.config);
        archiveReplacedGoal(workspaceDir, scope.sessionKey, existing.goal, note);
      }
      const cleared = await clearSessionGoal(scope);
      return jsonResult({
        status: cleared ? "cleared" : "no-op",
        wasArchived: archive && existing.status === "found" && !!existing.goal,
      });
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
