/**
 * subagents built-in tool.
 *
 * Lists and cancels background work in the caller's session tree.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { resolveAcpSessionControlOwner } from "../../acp/runtime/session-control-owner.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  listTaskRecordsForOwnerTree,
  prepareTaskRegistryRead,
} from "../../tasks/runtime-internal.js";
import { readTaskBackingInstance } from "../../tasks/task-backing-records.js";
import {
  withTaskCancellationContext,
  type TaskCancellationTarget,
} from "../../tasks/task-cancellation-context.js";
import { getTaskExecutionObservation } from "../../tasks/task-execution-observation.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import { onTaskRegistryChange } from "../../tasks/task-registry.store.js";
import type { TaskRegistryObserverEvent } from "../../tasks/task-registry.store.types.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { resolveTaskSessionAgentId } from "../../tasks/task-session-identity.js";
import { TASK_STATUS_DETAIL_MAX_CHARS, sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  ensureSubagentControllerOwnsRun,
  isSubagentRunVisibleToSession,
} from "../subagents/registry/subagent-control-scope.js";
import {
  DEFAULT_RECENT_MINUTES,
  buildControlledSubagentRunsReadContext,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagents/registry/subagent-control.js";
import {
  buildSubagentList,
  readSubagentListSessionEntries,
} from "../subagents/registry/subagent-list.js";
import { buildLatestSubagentSessionListReadIndex } from "../subagents/registry/subagent-registry-read.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  onSubagentRegistryPersisted,
  prepareSubagentSessionListReadCache,
} from "../subagents/registry/subagent-registry-state.js";
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
  listTasks?: () => TaskRecord[];
  cancelTask?: typeof cancelDetachedTaskRunById;
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function taskOwnerMatches(
  task: TaskCancellationTarget,
  allowedOwnerKeys: ReadonlySet<string>,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return (
    allowedOwnerKeys.has(task.ownerKey) &&
    resolveTaskSessionAgentId(task.ownerKey, task.requesterAgentId, cfg) === agentId
  );
}

function readTaskTree(
  tasks: TaskRecord[],
  rootSessionKeys: ReadonlySet<string>,
  rootAgentId: string,
  cfg: OpenClawConfig,
  subagentOwnership: "retained" | "visible" | "controlled" = "retained",
) {
  const visibleSessions = new Map<
    string,
    { controllerSessionKey: string; controllerAgentId: string }
  >();
  for (const key of rootSessionKeys) {
    visibleSessions.set(`${rootAgentId}\0${key}`, {
      controllerSessionKey: key,
      controllerAgentId: rootAgentId,
    });
  }
  const visibleTasks = new Set<string>();
  const subagentReadIndex =
    subagentOwnership === "retained"
      ? undefined
      : buildLatestSubagentSessionListReadIndex(
          tasks.flatMap((task) =>
            task.runtime === "subagent" && task.childSessionKey ? [task.childSessionKey] : [],
          ),
        );
  const acpControlOwners = new Map<string, string | undefined>();
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
        subagentOwnership !== "retained" &&
        task.runtime === "subagent" &&
        (subagentOwnership === "controlled" ||
          readTaskBackingInstance(task.detail)?.runtime === "subagent") &&
        task.runId &&
        task.childSessionKey
      ) {
        const run = subagentReadIndex?.getLatestSubagentRun(task.childSessionKey);
        if (
          !run ||
          !taskRequesterAgentId ||
          !isSubagentRunVisibleToSession(run, task.ownerKey, taskRequesterAgentId, cfg) ||
          (run.taskRunId ?? run.runId) !== task.runId ||
          (subagentOwnership === "controlled" &&
            ![...visibleSessions.values()].some(
              (controller) =>
                ensureSubagentControllerOwnsRun({ cfg, controller, entry: run }) === undefined,
            ))
        ) {
          continue;
        }
      }
      visibleTasks.add(task.taskId);
      if (task.childSessionKey) {
        const childAgentId = task.agentId ?? taskRequesterAgentId ?? "";
        const childIdentity = `${childAgentId}\0${task.childSessionKey}`;
        if (!visibleSessions.has(childIdentity)) {
          // Retained task rows remain readable; ACP control edges follow the current owner.
          if (subagentOwnership === "controlled" && task.runtime === "acp") {
            if (!acpControlOwners.has(childIdentity)) {
              const current = readAcpSessionEntry({
                cfg,
                sessionKey: task.childSessionKey,
                agentId: task.agentId,
                clone: false,
              });
              acpControlOwners.set(
                childIdentity,
                current?.acp ? resolveAcpSessionControlOwner(current.entry) : undefined,
              );
            }
            if (acpControlOwners.get(childIdentity) !== task.ownerKey) {
              continue;
            }
          }
          visibleSessions.set(childIdentity, {
            controllerSessionKey: task.childSessionKey,
            controllerAgentId: childAgentId,
          });
          changed = true;
        }
      }
    }
  }
  return {
    tasks: tasks.filter((task) => visibleTasks.has(task.taskId)),
    sessions: visibleSessions,
  };
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
  taskChangeAffectsRead: (event?: TaskRegistryObserverEvent) => boolean;
  subagentChangeAffectsRead: (sessionKeys?: readonly (string | undefined)[]) => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  // A publisher's temporary scope must not own preparation started by its wake.
  const inWaitContext = AsyncLocalStorage.snapshot();
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
    let preparation: Promise<void> | undefined;
    let timedOut = params.timeoutMs === 0;
    let abortError: Error | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
    };
    const finish = () =>
      inWaitContext(() => {
        if (settled || preparation) {
          return;
        }
        try {
          if (abortError) {
            fail(abortError);
            return;
          }
          if (!getSubagentSessionListReadSnapshotIdentity()) {
            preparation = prepareSubagentSessionListReadCache();
            void preparation.then(
              () => {
                preparation = undefined;
                finish();
              },
              (error: unknown) => {
                preparation = undefined;
                fail(error);
              },
            );
            return;
          }
          const state = read();
          if (!timedOut && !state.reason) {
            return;
          }
          settled = true;
          cleanup();
          resolve({ ...state, reason: state.reason ?? "timeout" });
        } catch (error) {
          fail(error);
        }
      });
    const onAbort = () => {
      abortError = createAbortError("subagents wait aborted; tasks continue running.");
      // Accepted preparation keeps custody until both the read and cleanup settle.
      finish();
    };
    let wakeQueued = false;
    const wake = () => {
      if (wakeQueued || settled) {
        return;
      }
      wakeQueued = true;
      // The publisher retires its mutation before a reader checks the resulting identity.
      queueMicrotask(() => {
        wakeQueued = false;
        finish();
      });
    };
    const unsubscribeTasks = onTaskRegistryChange((event) => {
      if (params.taskChangeAffectsRead(event)) {
        wake();
      }
    });
    const unsubscribeSubagents = onSubagentRegistryPersisted((keys) => {
      if (params.subagentChangeAffectsRead(keys)) {
        wake();
      }
    });
    unsubscribe = () => {
      unsubscribeTasks();
      unsubscribeSubagents();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, params.timeoutMs);
    if (params.signal?.aborted) {
      onAbort();
    } else {
      // Subscribe before reading so completion cannot be lost between those operations.
      finish();
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
  const assertCancellationControl = (task: TaskCancellationTarget) => {
    const current = readScope();
    if (task.scopeKind !== "session") {
      throw new Error("Task outside session tree.");
    }
    if (taskOwnerMatches(task, current.allowedOwnerKeys, current.controllerAgentId, current.cfg)) {
      return;
    }
    if (current.controller.controlScope !== "children") {
      throw new Error("Leaf subagents cannot cancel other sessions.");
    }
    const tree = readTaskTree(
      opts.listTasks?.() ?? listTaskRecordsForOwnerTree(current.allowedOwnerKeys),
      current.allowedOwnerKeys,
      current.controllerAgentId,
      current.cfg,
      "controlled",
    );
    const ownerAgentId = resolveTaskSessionAgentId(
      task.ownerKey,
      task.requesterAgentId,
      current.cfg,
    );
    // Runtime owners fence the selected target; this check fences its caller ancestry.
    if (!tree.sessions.has(`${ownerAgentId ?? ""}\0${task.ownerKey}`)) {
      throw new Error("Task outside session tree.");
    }
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
      while (!getSubagentSessionListReadSnapshotIdentity()) {
        await prepareSubagentSessionListReadCache();
      }
      const prepared =
        !opts.listTasks && (action === "list" || action === "wait")
          ? await prepareTaskRegistryRead()
          : undefined;
      if (!opts.listTasks && (action === "list" || action === "wait") && !prepared) {
        throw new Error("Task activity did not stabilize. Retry the task read.");
      }
      const listTasks = (owners: ReadonlySet<string>) =>
        opts.listTasks
          ? opts.listTasks()
          : prepared
            ? prepared.listTaskRecordsForOwnerTree(owners)
            : listTaskRecordsForOwnerTree(owners);

      if (action === "wait") {
        const taskIds = [...new Set(readStringArrayParam(params, "taskIds", { required: true }))];
        if (taskIds.length > 32) {
          throw new ToolInputError("subagents wait supports at most 32 taskIds.");
        }
        const timeoutSeconds = Math.min(
          60,
          readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30,
        );
        let dependencies = new Set(taskIds);
        let ancestorSessionKeys = new Set<string>();
        let subagentSessionKeys = new Set<string>();
        const readSelectedTasks = () => {
          const current = readScope();
          const isRootTask = (task: Readonly<TaskRecord>) =>
            taskOwnerMatches(
              task,
              current.allowedOwnerKeys,
              current.controllerAgentId,
              current.cfg,
            );
          const candidates = opts.listTasks
            ? opts.listTasks()
            : prepared!.listTaskRecordsWithAncestors(taskIds, isRootTask);
          dependencies = new Set([...taskIds, ...candidates.map((task) => task.taskId)]);
          ancestorSessionKeys = new Set(
            candidates.flatMap((task) => (isRootTask(task) ? [] : [task.ownerKey])),
          );
          subagentSessionKeys = new Set(
            candidates.flatMap((task) =>
              task.runtime === "subagent" && task.childSessionKey ? [task.childSessionKey] : [],
            ),
          );
          return readTaskTree(
            candidates,
            current.allowedOwnerKeys,
            current.controllerAgentId,
            current.cfg,
            "visible",
          ).tasks;
        };
        const taskChangeAffectsRead = (event?: TaskRegistryObserverEvent) => {
          if (!event || event.kind === "restored") {
            return true;
          }
          const taskId = event.kind === "upserted" ? event.task.taskId : event.taskId;
          return (
            dependencies.has(taskId) ||
            [event.previous, event.kind === "upserted" ? event.task : undefined].some(
              (task) => task?.childSessionKey && ancestorSessionKeys.has(task.childSessionKey),
            )
          );
        };
        const result = await waitForSelectedTasks({
          taskIds,
          readTasks: readSelectedTasks,
          taskChangeAffectsRead,
          subagentChangeAffectsRead: (keys) =>
            !keys?.length || keys.some((key) => key !== undefined && subagentSessionKeys.has(key)),
          timeoutMs: timeoutSeconds * 1_000,
          signal,
        });
        return jsonResult({ status: "ok", action, ...result });
      }
      const { cfg, controller, controllerAgentId, allowedOwnerKeys } = readScope();
      const treeTasks = readTaskTree(
        listTasks(allowedOwnerKeys),
        allowedOwnerKeys,
        controllerAgentId,
        cfg,
        action === "cancel" ? "controlled" : "retained",
      ).tasks;

      if (action === "list") {
        const readContext = await buildControlledSubagentRunsReadContext(
          controller.controllerSessionKey,
          controllerAgentId,
          cfg,
          recentMinutes,
        );
        const list = buildSubagentList({
          context: readContext.list,
          sessionEntries: readSubagentListSessionEntries(cfg, readContext.list),
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
        const result = await withTaskCancellationContext(
          assertCancellationControl,
          () => (opts.cancelTask ?? cancelDetachedTaskRunById)({ cfg, taskId }),
          {
            selectedTask: target,
            prepareRead: () =>
              getSubagentSessionListReadSnapshotIdentity()
                ? undefined
                : prepareSubagentSessionListReadCache(),
          },
        );
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
