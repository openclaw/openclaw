/**
 * subagents built-in tool.
 *
 * Lists and cancels background work in the caller's session tree.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { listTaskRecordsUnsorted } from "../../tasks/runtime-internal.js";
import { readTaskBackingInstance } from "../../tasks/task-backing-records.js";
import { getTaskExecutionObservation } from "../../tasks/task-execution-observation.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import { onTaskRegistryChange } from "../../tasks/task-registry-state.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { resolveTaskSessionAgentId } from "../../tasks/task-session-identity.js";
import { TASK_STATUS_DETAIL_MAX_CHARS, sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagents/registry/subagent-control.js";
import { buildSubagentList } from "../subagents/registry/subagent-list.js";
import { onSubagentRegistryPersisted } from "../subagents/registry/subagent-registry-state.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";

const SUBAGENT_ACTIONS = ["list", "wait", "cancel"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
  taskId: Type.Optional(Type.String({ description: "Task id" })),
  taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
});

const STATUS_MAP: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

type SubagentsToolOptions = {
  agentSessionKey?: string;
  /** Policy/sandbox key retained task rows may still carry from pre-change code, when it
   * differs from the durable {@link agentSessionKey}. Lets split-key callers (e.g. Telegram
   * DM) keep seeing and cancelling retained media/spawn tasks created before the durable-key
   * alignment. Undefined and equal-to-agentSessionKey values are no-ops. */
  callerPolicySessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  listTasks?: typeof listTaskRecordsUnsorted;
  cancelTask?: typeof cancelDetachedTaskRunById;
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function taskOwnerMatches(
  task: TaskRecord,
  allowedOwnerKeys: ReadonlySet<string>,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return (
    allowedOwnerKeys.has(task.ownerKey) &&
    resolveTaskSessionAgentId(task.ownerKey, task.requesterAgentId, cfg) === agentId
  );
}

function listTreeTasks(
  tasks: TaskRecord[],
  rootSessionKeys: ReadonlySet<string>,
  rootAgentId: string,
  cfg: OpenClawConfig,
  requireCurrentSubagentOwnership = false,
): TaskRecord[] {
  const visibleSessions = new Set<string>();
  for (const key of rootSessionKeys) {
    visibleSessions.add(`${rootAgentId}\0${key}`);
  }
  const visibleTasks = new Set<string>();
  const controlledRunsByOwner = new Map<string, ReturnType<typeof listControlledSubagentRuns>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.scopeKind !== "session" || visibleTasks.has(task.taskId)) {
        continue;
      }
      const taskRequesterAgentId = resolveTaskSessionAgentId(
        task.ownerKey,
        task.requesterAgentId,
        cfg,
      );
      if (!visibleSessions.has(`${taskRequesterAgentId ?? ""}\0${task.ownerKey}`)) {
        continue;
      }
      if (
        requireCurrentSubagentOwnership &&
        task.runtime === "subagent" &&
        readTaskBackingInstance(task.detail)?.runtime === "subagent" &&
        task.runId &&
        task.childSessionKey
      ) {
        const owner = `${taskRequesterAgentId ?? ""}\0${task.ownerKey}`;
        let controlledRuns = controlledRunsByOwner.get(owner);
        if (!controlledRuns) {
          controlledRuns = listControlledSubagentRuns(task.ownerKey, taskRequesterAgentId, cfg);
          controlledRunsByOwner.set(owner, controlledRuns);
        }
        if (
          !controlledRuns.some(
            (run) =>
              run.childSessionKey === task.childSessionKey &&
              (run.taskRunId ?? run.runId) === task.runId,
          )
        ) {
          continue;
        }
      }
      visibleTasks.add(task.taskId);
      if (task.childSessionKey) {
        const childIdentity = `${task.agentId ?? taskRequesterAgentId ?? ""}\0${task.childSessionKey}`;
        if (!visibleSessions.has(childIdentity)) {
          visibleSessions.add(childIdentity);
          changed = true;
        }
      }
    }
  }
  return tasks.filter((task) => visibleTasks.has(task.taskId));
}

function mapTask(task: TaskRecord) {
  // Task failures can contain hidden provider/runtime context; reuse the bounded status owner.
  const error = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  const execution = getTaskExecutionObservation(task);
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    deliveryStatus: task.deliveryStatus,
    ...(execution ? { execution } : {}),
    ...(execution.wait?.kind === "external" && task.childSessionKey
      ? { resume: { method: "sessions.send", sessionKey: task.childSessionKey } }
      : {}),
    status:
      task.status === "succeeded" && task.terminalOutcome === "blocked"
        ? "blocked"
        : STATUS_MAP[task.status],
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
    ...(error ? { error } : {}),
  };
}

function waitForSelectedTasks(params: {
  taskIds: string[];
  readTasks: () => TaskRecord[];
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const read = () => {
    const visible = new Map(params.readTasks().map((task) => [task.taskId, task]));
    const tasks = params.taskIds.flatMap((taskId) => {
      const task = visible.get(taskId);
      return task ? [task] : [];
    });
    const unavailable = params.taskIds.filter((taskId) => !visible.has(taskId));
    const attention = tasks.filter((task) => {
      const wait = getTaskExecutionObservation(task).wait;
      return (
        task.terminalOutcome === "blocked" ||
        wait?.kind === "approval" ||
        wait?.kind === "user_input"
      );
    });
    const completed = tasks.filter((task) => task.status !== "queued" && task.status !== "running");
    return {
      reason: unavailable.length
        ? "unavailable"
        : attention.length
          ? "attention"
          : completed.length
            ? "completed"
            : undefined,
      tasks: tasks.map(mapTask),
      completed: completed.map((task) => task.taskId),
      attention: attention.map((task) => task.taskId),
      ...(unavailable.length ? { unavailable } : {}),
    };
  };
  return new Promise<ReturnType<typeof read>>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error, timeout = false) => {
      if (settled) {
        return;
      }
      try {
        const state = error ? undefined : read();
        if (!error && !timeout && !state?.reason) {
          return;
        }
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else if (state) {
          resolve({ ...state, reason: state.reason ?? "timeout" });
        }
      } catch (readError) {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        reject(
          readError instanceof Error
            ? readError
            : new Error(String(readError), { cause: readError }),
        );
      }
    };
    const onAbort = () =>
      finish(createAbortError("subagents wait aborted; tasks continue running."));
    const unsubscribeTasks = onTaskRegistryChange(() => finish());
    const unsubscribeSubagents = onSubagentRegistryPersisted(() => finish());
    unsubscribe = () => {
      unsubscribeTasks();
      unsubscribeSubagents();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(undefined, true), params.timeoutMs);
    if (params.signal?.aborted) {
      onAbort();
    } else {
      // Subscribe before reading so completion cannot be lost between those operations.
      finish(undefined, params.timeoutMs === 0);
    }
  });
}

/** Creates the subagents list tool scoped to the caller's controlled session tree. */
export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  const readScope = () => {
    const cfg = opts.config ?? getRuntimeConfig();
    const controller = resolveSubagentController({
      cfg,
      agentSessionKey: opts.agentSessionKey,
      agentId: opts.agentId,
    });
    const controllerAgentId = controller.controllerAgentId;
    if (!controllerAgentId) {
      throw new ToolInputError("subagent controller agent required");
    }
    // Retained policy-key rows remain readable for split-key callers.
    const allowedOwnerKeys = new Set<string>([controller.controllerSessionKey]);
    const callerPolicySessionKey = opts.callerPolicySessionKey?.trim();
    if (callerPolicySessionKey) {
      allowedOwnerKeys.add(callerPolicySessionKey);
    }
    return { cfg, controller, controllerAgentId, allowedOwnerKeys };
  };
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "Background work: list status, wait for selected taskIds to finish or need attention, or cancel a taskId. wait keeps this turn active; timeout does not cancel work or consume completion delivery.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = (readToolStringParam(params, "action") ?? "list") as SubagentAction;
      const recentMinutesRaw = readPositiveIntegerParam(params, "recentMinutes");
      const recentMinutes =
        recentMinutesRaw === undefined
          ? DEFAULT_RECENT_MINUTES
          : Math.min(MAX_RECENT_MINUTES, recentMinutesRaw);
      const readTreeTasks = () => {
        const current = readScope();
        return listTreeTasks(
          (opts.listTasks ?? listTaskRecordsUnsorted)(),
          current.allowedOwnerKeys,
          current.controllerAgentId,
          current.cfg,
          true,
        );
      };

      if (action === "wait") {
        const taskIds = [...new Set(readStringArrayParam(params, "taskIds", { required: true }))];
        if (taskIds.length > 32) {
          throw new ToolInputError("subagents wait supports at most 32 taskIds.");
        }
        const timeoutSeconds = Math.min(
          60,
          readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30,
        );
        const result = await waitForSelectedTasks({
          taskIds,
          readTasks: readTreeTasks,
          timeoutMs: timeoutSeconds * 1_000,
          signal,
        });
        return jsonResult({ status: "ok", action, ...result });
      }
      const { cfg, controller, controllerAgentId, allowedOwnerKeys } = readScope();
      const treeTasks = listTreeTasks(
        (opts.listTasks ?? listTaskRecordsUnsorted)(),
        allowedOwnerKeys,
        controllerAgentId,
        cfg,
      );

      if (action === "list") {
        const runs = listControlledSubagentRuns(
          controller.controllerSessionKey,
          controllerAgentId,
          cfg,
        );
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        const cutoff = Date.now() - recentMinutes * 60_000;
        const tasks = treeTasks
          .filter(
            (task) =>
              task.status === "queued" ||
              task.status === "running" ||
              taskUpdatedAt(task) >= cutoff,
          )
          .toSorted((left, right) => taskUpdatedAt(right) - taskUpdatedAt(left))
          .map(mapTask);
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          taskTotal: tasks.length,
          tasks,
          sharedCwdGroupTotal: list.sharedCwdGroupTotal,
          sharedCwdGroups: list.sharedCwdGroups,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "cancel") {
        const taskId = readToolStringParam(params, "taskId", { required: true });
        const target = treeTasks.find((task) => task.taskId === taskId);
        if (!target) {
          return jsonResult({ status: "forbidden", error: "Task outside session tree." });
        }
        // Leaf subagents may cancel only their own tasks, matching the
        // control-scope gate every other cross-session subagent mutation enforces.
        if (
          controller.controlScope !== "children" &&
          !taskOwnerMatches(target, allowedOwnerKeys, controllerAgentId, cfg)
        ) {
          return jsonResult({
            status: "forbidden",
            error: "Leaf subagents cannot cancel other sessions.",
          });
        }
        const result = await (opts.cancelTask ?? cancelDetachedTaskRunById)({ cfg, taskId });
        return jsonResult({
          status: result.cancelled ? "cancelled" : "error",
          taskId,
          found: result.found,
          cancelled: result.cancelled,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
