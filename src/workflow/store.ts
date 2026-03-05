import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../routing/session-key.js";
import type {
  WorkflowPlan,
  WorkflowStore,
  WorkflowPlanCreate,
  WorkflowTaskUpdate,
  WorkflowPlanPatch,
  WorkflowEvent,
  WorkflowTaskStatus,
} from "./types.js";
import { createWorkflowPlan, isWorkflowPlanComplete, generateWorkflowTaskId } from "./types.js";

const log = createSubsystemLogger("workflow/store");

const DEFAULT_WORKFLOW_DIRNAME = "workflows";

export function resolveWorkflowDir(agentId?: string): string {
  const root = resolveStateDir();
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, DEFAULT_WORKFLOW_DIRNAME);
}

export function resolveWorkflowStorePath(agentId?: string): string {
  return path.join(resolveWorkflowDir(agentId), "plans.json");
}

export function resolveWorkflowHistoryDir(agentId?: string): string {
  return path.join(resolveWorkflowDir(agentId), "history");
}

const VALID_PLAN_ID_RE = /^wfp_[a-f0-9]+$/;

export function isValidPlanId(planId: string): boolean {
  return VALID_PLAN_ID_RE.test(planId);
}

export function resolveWorkflowHistoryPath(agentId: string, planId: string): string {
  if (!isValidPlanId(planId)) {
    throw new Error(`Invalid plan ID format: ${planId}`);
  }
  return path.join(resolveWorkflowHistoryDir(agentId), `${planId}.json`);
}

function isWorkflowStoreRecord(value: unknown): value is WorkflowStore {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1
  );
}

export async function loadWorkflowStore(storePath: string): Promise<WorkflowStore> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (isWorkflowStoreRecord(parsed)) {
      return parsed;
    }
    return { version: 1, activePlans: {} };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, activePlans: {} };
    }
    throw err;
  }
}

export async function saveWorkflowStore(storePath: string, store: WorkflowStore): Promise<void> {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort backup
  }
}

export async function archiveWorkflowPlan(agentId: string, plan: WorkflowPlan): Promise<string> {
  const historyDir = resolveWorkflowHistoryDir(agentId);
  await fs.promises.mkdir(historyDir, { recursive: true });
  const historyPath = resolveWorkflowHistoryPath(agentId, plan.id);
  const json = JSON.stringify(plan, null, 2);
  await fs.promises.writeFile(historyPath, json, "utf-8");
  log.info("archived workflow plan", { planId: plan.id, historyPath });
  return historyPath;
}

export async function loadArchivedWorkflowPlan(
  agentId: string,
  planId: string,
): Promise<WorkflowPlan | null> {
  const historyPath = resolveWorkflowHistoryPath(agentId, planId);
  try {
    const raw = await fs.promises.readFile(historyPath, "utf-8");
    return JSON.parse(raw) as WorkflowPlan;
  } catch {
    return null;
  }
}

export async function listArchivedWorkflowPlans(
  agentId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ plans: WorkflowPlan[]; total: number }> {
  const historyDir = resolveWorkflowHistoryDir(agentId);
  try {
    const files = await fs.promises.readdir(historyDir);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .toSorted()
      .toReversed();
    const total = jsonFiles.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    const slice = jsonFiles.slice(offset, offset + limit);

    const plans: WorkflowPlan[] = [];
    for (const file of slice) {
      const planId = file.replace(".json", "");
      const plan = await loadArchivedWorkflowPlan(agentId, planId);
      if (plan) {
        plans.push(plan);
      }
    }
    return { plans, total };
  } catch {
    return { plans: [], total: 0 };
  }
}

export type WorkflowStoreManager = {
  getActivePlan: (planId: string) => Promise<WorkflowPlan | null>;
  getActivePlans: () => Promise<WorkflowPlan[]>;
  createPlan: (params: WorkflowPlanCreate) => Promise<WorkflowPlan>;
  updatePlan: (planId: string, patch: WorkflowPlanPatch) => Promise<WorkflowPlan | null>;
  updateTask: (params: WorkflowTaskUpdate) => Promise<WorkflowPlan | null>;
  addTask: (planId: string, content: string) => Promise<WorkflowPlan | null>;
  startTask: (planId: string, taskId: string) => Promise<WorkflowPlan | null>;
  completePlan: (planId: string, status?: "completed" | "failed") => Promise<WorkflowPlan | null>;
  deletePlan: (planId: string) => Promise<boolean>;
  listHistory: (opts?: { limit?: number; offset?: number }) => Promise<{
    plans: WorkflowPlan[];
    total: number;
  }>;
  getHistoryPlan: (planId: string) => Promise<WorkflowPlan | null>;
};

export function createWorkflowStoreManager(agentId: string): WorkflowStoreManager {
  const storePath = resolveWorkflowStorePath(agentId);
  const eventListeners: Array<(event: WorkflowEvent) => void> = [];

  const emitEvent = (event: WorkflowEvent): void => {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn("workflow event listener error", { error: err });
      }
    }
  };

  const getActivePlan = async (planId: string): Promise<WorkflowPlan | null> => {
    const store = await loadWorkflowStore(storePath);
    return store.activePlans[planId] ?? null;
  };

  const getActivePlans = async (): Promise<WorkflowPlan[]> => {
    const store = await loadWorkflowStore(storePath);
    return Object.values(store.activePlans).toSorted(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  };

  const createPlan = async (params: WorkflowPlanCreate): Promise<WorkflowPlan> => {
    const store = await loadWorkflowStore(storePath);
    const plan = createWorkflowPlan({ ...params, agentId });
    store.activePlans[plan.id] = plan;
    await saveWorkflowStore(storePath, store);
    log.info("created workflow plan", { planId: plan.id, title: plan.title });
    emitEvent({
      type: "plan.created",
      planId: plan.id,
      plan,
      timestamp: new Date().toISOString(),
    });
    return plan;
  };

  const updatePlan = async (
    planId: string,
    patch: WorkflowPlanPatch,
  ): Promise<WorkflowPlan | null> => {
    const store = await loadWorkflowStore(storePath);
    const plan = store.activePlans[planId];
    if (!plan) {
      return null;
    }
    const updatedPlan: WorkflowPlan = {
      ...plan,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    store.activePlans[planId] = updatedPlan;
    await saveWorkflowStore(storePath, store);
    emitEvent({
      type: "plan.updated",
      planId,
      plan: updatedPlan,
      timestamp: new Date().toISOString(),
    });
    return updatedPlan;
  };

  const updateTask = async (params: WorkflowTaskUpdate): Promise<WorkflowPlan | null> => {
    const { planId, taskId, status, result, error } = params;
    const store = await loadWorkflowStore(storePath);
    const plan = store.activePlans[planId];
    if (!plan) {
      return null;
    }

    const taskIndex = plan.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return null;
    }

    const now = new Date().toISOString();
    const task = plan.tasks[taskIndex];
    const updatedTask = {
      ...task,
      status,
      result: result ?? task.result,
      error: error ?? task.error,
      completedAt: ["completed", "failed", "skipped"].includes(status) ? now : task.completedAt,
    };

    plan.tasks[taskIndex] = updatedTask;
    plan.updatedAt = now;

    // Update plan status based on task progress
    const hasInProgress = plan.tasks.some((t) => t.status === "in_progress");
    const allDone = isWorkflowPlanComplete(plan);

    if (hasInProgress && plan.status === "pending") {
      plan.status = "in_progress";
      plan.startedAt = plan.startedAt ?? now;
    }

    if (allDone && plan.status === "in_progress") {
      const hasFailed = plan.tasks.some((t) => t.status === "failed");
      plan.status = hasFailed ? "failed" : "completed";
      plan.completedAt = now;
    }

    store.activePlans[planId] = plan;
    await saveWorkflowStore(storePath, store);

    const eventType: WorkflowEvent["type"] =
      status === "completed"
        ? "task.completed"
        : status === "failed"
          ? "task.failed"
          : status === "skipped"
            ? "task.skipped"
            : "task.started";

    emitEvent({
      type: eventType,
      planId,
      taskId,
      plan,
      task: updatedTask,
      timestamp: now,
    });

    if (allDone) {
      emitEvent({
        type: plan.status === "failed" ? "plan.failed" : "plan.completed",
        planId,
        plan,
        timestamp: now,
      });
    }

    return plan;
  };

  const startTask = async (planId: string, taskId: string): Promise<WorkflowPlan | null> => {
    const store = await loadWorkflowStore(storePath);
    const plan = store.activePlans[planId];
    if (!plan) {
      return null;
    }

    const taskIndex = plan.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return null;
    }

    const now = new Date().toISOString();
    const task = plan.tasks[taskIndex];

    plan.tasks[taskIndex] = {
      ...task,
      status: "in_progress",
      startedAt: now,
    };
    plan.updatedAt = now;

    if (plan.status === "pending") {
      plan.status = "in_progress";
      plan.startedAt = now;
    }

    store.activePlans[planId] = plan;
    await saveWorkflowStore(storePath, store);

    emitEvent({
      type: "task.started",
      planId,
      taskId,
      plan,
      task: plan.tasks[taskIndex],
      timestamp: now,
    });

    return plan;
  };

  const addTask = async (planId: string, content: string): Promise<WorkflowPlan | null> => {
    const store = await loadWorkflowStore(storePath);
    const plan = store.activePlans[planId];
    if (!plan) {
      return null;
    }

    const now = new Date().toISOString();
    const newTask = {
      id: generateWorkflowTaskId(),
      content,
      status: "pending" as WorkflowTaskStatus,
      order: plan.tasks.length,
    };

    plan.tasks.push(newTask);
    plan.updatedAt = now;
    store.activePlans[planId] = plan;
    await saveWorkflowStore(storePath, store);

    emitEvent({
      type: "plan.updated",
      planId,
      plan,
      timestamp: now,
    });

    return plan;
  };

  const completePlan = async (
    planId: string,
    status: "completed" | "failed" = "completed",
  ): Promise<WorkflowPlan | null> => {
    const store = await loadWorkflowStore(storePath);
    const plan = store.activePlans[planId];
    if (!plan) {
      return null;
    }

    const now = new Date().toISOString();
    plan.status = status;
    plan.completedAt = now;
    plan.updatedAt = now;

    // Archive the plan
    await archiveWorkflowPlan(agentId, plan);
    delete store.activePlans[planId];
    await saveWorkflowStore(storePath, store);

    emitEvent({
      type: status === "failed" ? "plan.failed" : "plan.completed",
      planId,
      plan,
      timestamp: now,
    });

    return plan;
  };

  const deletePlan = async (planId: string): Promise<boolean> => {
    const store = await loadWorkflowStore(storePath);

    // Check active plans first
    if (store.activePlans[planId]) {
      delete store.activePlans[planId];
      await saveWorkflowStore(storePath, store);
      return true;
    }

    // Check history plans
    const historyPath = resolveWorkflowHistoryPath(agentId, planId);
    try {
      await fs.promises.access(historyPath);
      await fs.promises.unlink(historyPath);
      return true;
    } catch {
      return false;
    }
  };

  const listHistory = async (opts?: {
    limit?: number;
    offset?: number;
  }): Promise<{ plans: WorkflowPlan[]; total: number }> => {
    return await listArchivedWorkflowPlans(agentId, opts);
  };

  const getHistoryPlan = async (planId: string): Promise<WorkflowPlan | null> => {
    return await loadArchivedWorkflowPlan(agentId, planId);
  };

  return {
    getActivePlan,
    getActivePlans,
    createPlan,
    updatePlan,
    updateTask,
    addTask,
    startTask,
    completePlan,
    deletePlan,
    listHistory,
    getHistoryPlan,
  };
}

export type WorkflowService = {
  manager: WorkflowStoreManager;
  agentId: string;
  addTask: (planId: string, content: string) => Promise<WorkflowPlan | null>;
  getNextPendingTask: (planId: string) => Promise<{ plan: WorkflowPlan; taskId: string } | null>;
};

export function createWorkflowService(agentId: string): WorkflowService {
  const manager = createWorkflowStoreManager(agentId);

  const addTask = async (planId: string, content: string): Promise<WorkflowPlan | null> => {
    return manager.addTask(planId, content);
  };

  const getNextPendingTask = async (
    planId: string,
  ): Promise<{ plan: WorkflowPlan; taskId: string } | null> => {
    const plan = await manager.getActivePlan(planId);
    if (!plan) {
      return null;
    }

    const pendingTask = plan.tasks.find((t) => t.status === "pending");
    if (!pendingTask) {
      return null;
    }

    return { plan, taskId: pendingTask.id };
  };

  return {
    manager,
    agentId,
    addTask,
    getNextPendingTask,
  };
}
