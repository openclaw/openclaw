import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireTaskLock } from "../../infra/task-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  TaskDelegation,
  DelegationEvent,
  DelegationSummary,
} from "./task-delegation-types.js";

const _log = createSubsystemLogger("task-file-io");

const TASKS_DIR = "tasks";
const TASK_HISTORY_DIR = "task-history";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";

export function getMonthlyHistoryFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}.md`;
}

export type TaskStatus =
  | "pending"
  | "pending_approval"
  | "in_progress"
  | "blocked"
  | "backlog"
  | "completed"
  | "cancelled"
  | "abandoned"
  | "interrupted";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type EscalationState = "none" | "requesting" | "escalated" | "failed";
export type EstimatedEffort = "small" | "medium" | "large";

/** Discriminated union describing how a task ended. */
export type TaskOutcome =
  | { kind: "completed"; summary?: string }
  | { kind: "cancelled"; reason?: string; by?: string }
  | { kind: "error"; error: string; retriable?: boolean }
  | { kind: "interrupted"; by?: string; reason?: string };
export type TaskStepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface TaskStep {
  id: string;
  content: string;
  status: TaskStepStatus;
  order: number;
}

export interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  workSessionId?: string;
  previousWorkSessionId?: string;
  progress: string[];
  // Blocked task fields for unblock request automation
  blockedReason?: string;
  unblockedBy?: string[];
  unblockedAction?: string;
  unblockRequestCount?: number;
  lastUnblockerIndex?: number;
  lastUnblockRequestAt?: string;
  escalationState?: EscalationState;
  unblockRequestFailures?: number;
  // Backlog task fields
  createdBy?: string; // Who added this task (user/agent id)
  assignee?: string; // Whose backlog (for cross-agent requests)
  dependsOn?: string[]; // Task IDs that must complete first
  estimatedEffort?: EstimatedEffort;
  startDate?: string; // ISO date - don't start before this date
  dueDate?: string; // ISO date - deadline
  // Milestone integration fields
  milestoneId?: string; // Linked milestone ID in Task Hub
  milestoneItemId?: string; // Linked milestone item ID in Task Hub
  harnessProjectSlug?: string; // Harness project slug for spec tracking
  harnessItemId?: string; // Harness item ID for verification reporting
  reassignCount?: number; // Zombie recovery: number of times task was auto-reassigned
  createdBySessionKey?: string; // Session key that created this task (for enforcement scope)
  steps?: TaskStep[];
  simple?: boolean;
  /** Terminal outcome when task reaches completed/cancelled/interrupted. */
  outcome?: TaskOutcome;
  /** Subagent delegations linked to this task. */
  delegations?: TaskDelegation[];
  /** Delegation lifecycle events. */
  delegationEvents?: DelegationEvent[];
  /** Aggregated delegation summary. */
  delegationSummary?: DelegationSummary;
}

export function generateTaskId(): string {
  return `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function generateWorkSessionId(): string {
  return `ws_${crypto.randomUUID()}`;
}

export function normalizeWorkSessionId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function ensureTaskWorkSessionId(task: TaskFile): string {
  const existing = normalizeWorkSessionId(task.workSessionId);
  if (existing) {
    task.workSessionId = existing;
    return existing;
  }
  const generated = generateWorkSessionId();
  task.workSessionId = generated;
  return generated;
}

const VALID_STATUSES = new Set<string>([
  "in_progress",
  "completed",
  "pending",
  "pending_approval",
  "blocked",
  "backlog",
  "cancelled",
  "abandoned",
  "interrupted",
]);
const VALID_PRIORITIES = new Set<string>(["low", "medium", "high", "urgent"]);

export function isValidTaskStatus(s: string): s is TaskStatus {
  return VALID_STATUSES.has(s);
}

export function isValidTaskPriority(p: string): p is TaskPriority {
  return VALID_PRIORITIES.has(p);
}

export function formatTaskFileMd(task: TaskFile): string {
  const lines = [
    `# Task: ${task.id}`,
    "",
    "## Metadata",
    `- **Status:** ${task.status}`,
    `- **Priority:** ${task.priority}`,
    `- **Created:** ${task.created}`,
  ];

  if (task.source) {
    lines.push(`- **Source:** ${task.source}`);
  }
  if (task.workSessionId) {
    lines.push(`- **Work Session:** ${task.workSessionId}`);
  }
  if (task.previousWorkSessionId) {
    lines.push(`- **Previous Work Session:** ${task.previousWorkSessionId}`);
  }
  if (task.createdBySessionKey) {
    lines.push(`- **Created By Session:** ${task.createdBySessionKey}`);
  }
  if (task.simple) {
    lines.push(`- **Simple:** true`);
  }

  lines.push("", "## Description", task.description, "");

  if (task.context) {
    lines.push("## Context", task.context, "");
  }

  if (task.steps && task.steps.length > 0) {
    lines.push("## Steps");
    const sortedSteps = [...task.steps].toSorted((a, b) => a.order - b.order);
    for (const step of sortedSteps) {
      const marker =
        step.status === "done"
          ? "x"
          : step.status === "in_progress"
            ? ">"
            : step.status === "skipped"
              ? "-"
              : " ";
      lines.push(`- [${marker}] (${step.id}) ${step.content}`);
    }
    lines.push("");
  }

  lines.push("## Progress");
  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## Last Activity", task.lastActivity, "");

  // Serialize blocking fields if present
  if (task.status === "blocked" || task.blockedReason || task.unblockedBy) {
    const blockingData = {
      blockedReason: task.blockedReason,
      unblockedBy: task.unblockedBy,
      unblockedAction: task.unblockedAction,
      unblockRequestCount: task.unblockRequestCount,
      lastUnblockerIndex: task.lastUnblockerIndex,
      lastUnblockRequestAt: task.lastUnblockRequestAt,
      escalationState: task.escalationState,
      unblockRequestFailures: task.unblockRequestFailures,
    };
    lines.push("## Blocking", "```json", JSON.stringify(blockingData), "```", "");
  }

  // Serialize backlog fields if present
  if (
    task.status === "backlog" ||
    task.createdBy ||
    task.assignee ||
    task.dependsOn ||
    task.startDate ||
    task.dueDate
  ) {
    const backlogData = {
      createdBy: task.createdBy,
      assignee: task.assignee,
      dependsOn: task.dependsOn,
      estimatedEffort: task.estimatedEffort,
      startDate: task.startDate,
      dueDate: task.dueDate,
      milestoneId: task.milestoneId,
      milestoneItemId: task.milestoneItemId,
      harnessProjectSlug: task.harnessProjectSlug,
      harnessItemId: task.harnessItemId,
      reassignCount: task.reassignCount,
    };
    lines.push("## Backlog", "```json", JSON.stringify(backlogData), "```", "");
  }

  // Serialize outcome if present
  if (task.outcome) {
    lines.push("## Outcome", "```json", JSON.stringify(task.outcome), "```", "");
  }

  // Serialize delegations if present
  if (task.delegations && task.delegations.length > 0) {
    const delegationsData = {
      delegations: task.delegations,
      events: task.delegationEvents ?? [],
      summary: task.delegationSummary,
    };
    lines.push("## Delegations", "```json", JSON.stringify(delegationsData), "```", "");
  }

  lines.push("---", "*Managed by task tools*");

  return lines.join("\n");
}

export function parseTaskFileMd(content: string, filename: string): TaskFile | null {
  if (!content || content.includes("*(No task)*")) {
    return null;
  }

  const idMatch = filename.match(/^(task_[a-z0-9_]+)\.md$/);
  const id = idMatch ? idMatch[1] : "";

  const lines = content.split("\n");
  let status: TaskStatus = "pending";
  let priority: TaskPriority = "medium";
  let description = "";
  let context: string | undefined;
  let source: string | undefined;
  let workSessionId: string | undefined;
  let previousWorkSessionId: string | undefined;
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];
  const steps: TaskStep[] = [];
  let blockedReason: string | undefined;
  let unblockedBy: string[] | undefined;
  let unblockedAction: string | undefined;
  let unblockRequestCount: number | undefined;
  let lastUnblockerIndex: number | undefined;
  let lastUnblockRequestAt: string | undefined;
  let escalationState: EscalationState | undefined;
  let unblockRequestFailures: number | undefined;
  let createdBy: string | undefined;
  let assignee: string | undefined;
  let dependsOn: string[] | undefined;
  let estimatedEffort: EstimatedEffort | undefined;
  let startDate: string | undefined;
  let dueDate: string | undefined;
  let milestoneId: string | undefined;
  let milestoneItemId: string | undefined;
  let harnessProjectSlug: string | undefined;
  let harnessItemId: string | undefined;
  let reassignCount: number | undefined;
  let createdBySessionKey: string | undefined;
  let simple: boolean | undefined;
  let outcome: TaskOutcome | undefined;
  let delegations: TaskDelegation[] | undefined;
  let delegationEvents: DelegationEvent[] | undefined;
  let delegationSummary: DelegationSummary | undefined;

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("# Task:")) {
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (currentSection === "metadata") {
      const statusMatch = trimmed.match(/^-?\s*\*\*Status:\*\*\s*(.+)$/);
      if (statusMatch) {
        const rawStatus = statusMatch[1];
        if (isValidTaskStatus(rawStatus)) {
          status = rawStatus;
        } else {
          return null;
        }
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        const rawPriority = priorityMatch[1];
        if (isValidTaskPriority(rawPriority)) {
          priority = rawPriority;
        }
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
      const workSessionMatch = trimmed.match(/^-?\s*\*\*Work Session:\*\*\s*(.+)$/);
      if (workSessionMatch) {
        workSessionId = normalizeWorkSessionId(workSessionMatch[1]);
      }
      const previousWorkSessionMatch = trimmed.match(
        /^-?\s*\*\*Previous Work Session:\*\*\s*(.+)$/,
      );
      if (previousWorkSessionMatch) {
        previousWorkSessionId = normalizeWorkSessionId(previousWorkSessionMatch[1]);
      }
      const createdBySessionMatch = trimmed.match(/^-?\s*\*\*Created By Session:\*\*\s*(.+)$/);
      if (createdBySessionMatch) {
        createdBySessionKey = createdBySessionMatch[1].trim() || undefined;
      }
      const simpleMatch = trimmed.match(/^-?\s*\*\*Simple:\*\*\s*(.+)$/);
      if (simpleMatch) {
        simple = simpleMatch[1].trim() === "true";
      }
    } else if (currentSection === "description") {
      description = description ? `${description}\n${trimmed}` : trimmed;
    } else if (currentSection === "context") {
      context = context ? `${context}\n${trimmed}` : trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "steps") {
      const stepMatch = trimmed.match(/^- \[([x> -])\] \((\w+)\) (.+)$/);
      if (stepMatch) {
        const [, marker, stepId, stepContent] = stepMatch;
        const stepStatus: TaskStepStatus =
          marker === "x"
            ? "done"
            : marker === ">"
              ? "in_progress"
              : marker === "-"
                ? "skipped"
                : "pending";
        steps.push({
          id: stepId,
          content: stepContent,
          status: stepStatus,
          order: steps.length + 1,
        });
      }
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
      }
    } else if (currentSection === "blocking") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const blockingData = JSON.parse(trimmed);
          blockedReason = blockingData.blockedReason;
          unblockedBy = blockingData.unblockedBy;
          unblockedAction = blockingData.unblockedAction;
          unblockRequestCount = blockingData.unblockRequestCount;
          lastUnblockerIndex = blockingData.lastUnblockerIndex;
          lastUnblockRequestAt = blockingData.lastUnblockRequestAt;
          escalationState = blockingData.escalationState;
          unblockRequestFailures = blockingData.unblockRequestFailures;
        } catch {
          // Ignore malformed JSON
        }
      }
    } else if (currentSection === "backlog") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const backlogData = JSON.parse(trimmed);
          createdBy = backlogData.createdBy;
          assignee = backlogData.assignee;
          dependsOn = backlogData.dependsOn;
          estimatedEffort = backlogData.estimatedEffort;
          startDate = backlogData.startDate;
          dueDate = backlogData.dueDate;
          milestoneId = backlogData.milestoneId;
          milestoneItemId = backlogData.milestoneItemId;
          harnessProjectSlug = backlogData.harnessProjectSlug;
          harnessItemId = backlogData.harnessItemId;
          if (typeof backlogData.reassignCount === "number") {
            reassignCount = backlogData.reassignCount;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    } else if (currentSection === "outcome") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const outcomeData = JSON.parse(trimmed);
          if (outcomeData.kind) {
            outcome = outcomeData as TaskOutcome;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    } else if (currentSection === "delegations") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const dData = JSON.parse(trimmed);
          if (Array.isArray(dData.delegations)) {
            delegations = dData.delegations;
          }
          if (Array.isArray(dData.events)) {
            delegationEvents = dData.events;
          }
          if (dData.summary && typeof dData.summary === "object") {
            delegationSummary = dData.summary;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    }
  }

  if (!description || !created) {
    return null;
  }

  return {
    id,
    status,
    priority,
    description,
    context,
    source,
    workSessionId,
    previousWorkSessionId,
    created,
    lastActivity: lastActivity || created,
    progress,
    steps: steps.length > 0 ? steps : undefined,
    simple,
    blockedReason,
    unblockedBy,
    unblockedAction,
    unblockRequestCount,
    lastUnblockerIndex,
    lastUnblockRequestAt,
    escalationState,
    unblockRequestFailures,
    createdBy,
    assignee,
    dependsOn,
    estimatedEffort,
    startDate,
    dueDate,
    milestoneId,
    milestoneItemId,
    harnessProjectSlug,
    harnessItemId,
    reassignCount,
    createdBySessionKey,
    outcome,
    delegations: delegations && delegations.length > 0 ? delegations : undefined,
    delegationEvents:
      delegationEvents && delegationEvents.length > 0 ? delegationEvents : undefined,
    delegationSummary,
  };
}

/**
 * Word-based Jaccard similarity for duplicate task detection.
 * Returns the most similar existing task above the threshold, or null.
 */
export function findSimilarTask(
  existingTasks: TaskFile[],
  newDescription: string,
  threshold = 0.5,
): TaskFile | null {
  const newWords = new Set(newDescription.toLowerCase().split(/\s+/).filter(Boolean));
  if (newWords.size === 0) {
    return null;
  }

  let bestTask: TaskFile | null = null;
  let bestScore = 0;

  for (const task of existingTasks) {
    const existingWords = new Set(task.description.toLowerCase().split(/\s+/).filter(Boolean));
    if (existingWords.size === 0) {
      continue;
    }

    let intersection = 0;
    for (const w of newWords) {
      if (existingWords.has(w)) {
        intersection++;
      }
    }
    const union = new Set([...newWords, ...existingWords]).size;
    const score = union > 0 ? intersection / union : 0;

    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  return bestScore >= threshold ? bestTask : null;
}

export async function getTasksDir(workspaceDir: string): Promise<string> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  await fs.mkdir(tasksDir, { recursive: true });
  return tasksDir;
}

export async function readTask(workspaceDir: string, taskId: string): Promise<TaskFile | null> {
  if (!taskId || /[/\\]/.test(taskId)) {
    return null;
  }
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.resolve(tasksDir, `${taskId}.md`);
  if (!filePath.startsWith(path.resolve(tasksDir) + path.sep)) {
    return null;
  }
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseTaskFileMd(content, `${taskId}.md`);
  } catch {
    return null;
  }
}

let writeCounter = 0;

export async function writeTask(workspaceDir: string, task: TaskFile): Promise<void> {
  ensureTaskWorkSessionId(task);
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.join(tasksDir, `${task.id}.md`);
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++writeCounter}`;
  const content = formatTaskFileMd(task);

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function deleteTask(workspaceDir: string, taskId: string): Promise<void> {
  if (!taskId || /[/\\]/.test(taskId)) {
    return;
  }
  const tasksDir = await getTasksDir(workspaceDir);
  const filePath = path.resolve(tasksDir, `${taskId}.md`);
  if (!filePath.startsWith(path.resolve(tasksDir) + path.sep)) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist, ignore
  }
}

export async function listTasks(
  workspaceDir: string,
  statusFilter?: TaskStatus | "all",
): Promise<TaskFile[]> {
  const tasksDir = await getTasksDir(workspaceDir);
  const tasks: TaskFile[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(tasksDir);
  } catch {
    return tasks;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || !file.startsWith("task_")) {
      continue;
    }
    try {
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || statusFilter === "all" || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    } catch {
      // File may have been deleted between readdir and readFile
    }
  }

  tasks.sort((a, b) => {
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    // For backlog tasks: due_date > start_date > created
    if (a.dueDate || b.dueDate) {
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) {
        return aDue - bDue;
      }
    }

    if (a.startDate || b.startDate) {
      const aStart = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const bStart = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      if (aStart !== bStart) {
        return aStart - bStart;
      }
    }

    return new Date(a.created).getTime() - new Date(b.created).getTime();
  });

  return tasks;
}

export async function findActiveTask(workspaceDir: string): Promise<TaskFile | null> {
  const tasks = await listTasks(workspaceDir, "in_progress");
  return tasks[0] || null;
}

export async function findPendingTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "pending");
}

export async function findPendingApprovalTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "pending_approval");
}

export async function findBlockedTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "blocked");
}

export async function findBacklogTasks(workspaceDir: string): Promise<TaskFile[]> {
  const tasks = await listTasks(workspaceDir, "backlog");
  const now = new Date();
  return tasks.filter((t) => {
    if (t.startDate) {
      const startDate = new Date(t.startDate);
      if (startDate > now) {
        return false;
      }
    }
    return true;
  });
}

export async function findAllBacklogTasks(workspaceDir: string): Promise<TaskFile[]> {
  return listTasks(workspaceDir, "backlog");
}

export async function checkDependenciesMet(
  workspaceDir: string,
  task: TaskFile,
): Promise<{ met: boolean; unmetDeps: string[] }> {
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return { met: true, unmetDeps: [] };
  }

  const unmetDeps: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = await readTask(workspaceDir, depId);
    if (!depTask) {
      // Task file deleted = completed/cancelled and archived to task-history
      continue;
    }
    if (depTask.status !== "completed") {
      unmetDeps.push(depId);
    }
  }

  return { met: unmetDeps.length === 0, unmetDeps };
}

export async function findPickableBacklogTask(workspaceDir: string): Promise<TaskFile | null> {
  const backlogTasks = await findBacklogTasks(workspaceDir);

  for (const task of backlogTasks) {
    const { met } = await checkDependenciesMet(workspaceDir, task);
    if (met) {
      return task;
    }
  }

  return null;
}

export async function appendToHistory(workspaceDir: string, entry: string): Promise<string> {
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  await fs.mkdir(historyDir, { recursive: true });

  const filename = getMonthlyHistoryFilename();
  const filePath = path.join(historyDir, filename);

  let lock: Awaited<ReturnType<typeof acquireTaskLock>> = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lock = await acquireTaskLock(workspaceDir, `history_${filename}`);
    if (lock) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
  }
  if (!lock) {
    throw new Error(`Failed to acquire history lock after ${maxRetries} retries`);
  }

  try {
    return await appendToHistoryLocked(filePath, filename, entry);
  } finally {
    await lock.release();
  }
}

export async function appendToHistoryLocked(
  filePath: string,
  filename: string,
  entry: string,
): Promise<string> {
  let needsHeader = false;
  try {
    await fs.access(filePath);
  } catch {
    needsHeader = true;
  }

  if (needsHeader) {
    const now = new Date();
    const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });
    const header = `# Task History - ${monthName}\n`;
    await fs.appendFile(filePath, header, "utf-8");
  }

  await fs.appendFile(filePath, entry, "utf-8");
  return `${TASK_HISTORY_DIR}/${filename}`;
}

export function formatTaskHistoryEntry(task: TaskFile, summary?: string): string {
  const completed = new Date().toISOString();
  const started = new Date(task.created);
  const completedDate = new Date(completed);
  const durationMs = completedDate.getTime() - started.getTime();
  const durationMins = Math.round(durationMs / 60000);
  const durationStr =
    durationMins >= 60
      ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
      : `${durationMins}m`;

  const lines = ["", "---", "", `## [${completed}] ${task.description}`, ""];

  if (task.context) {
    lines.push(`**Context:** ${task.context}`);
  }

  lines.push(
    `**Task ID:** ${task.id}`,
    `**Priority:** ${task.priority}`,
    `**Started:** ${task.created}`,
    `**Completed:** ${completed}`,
    `**Duration:** ${durationStr}`,
    "",
    "### Progress",
  );

  for (const item of task.progress) {
    lines.push(`- ${item}`);
  }

  if (summary) {
    lines.push("", "### Summary", summary);
  }

  return lines.join("\n");
}

export async function updateCurrentTaskPointer(
  workspaceDir: string,
  taskId: string | null,
): Promise<void> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  await fs.mkdir(workspaceDir, { recursive: true });

  if (!taskId) {
    const content = [
      "# Current Task",
      "",
      "*(No active focus task)*",
      "",
      "Use `task_list` to see all tasks.",
      "",
      "---",
      "*Managed by task tools*",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf-8");
    return;
  }

  const task = await readTask(workspaceDir, taskId);
  if (!task) {
    return;
  }

  const content = [
    "# Current Task",
    "",
    `**Focus:** ${task.id}`,
    "",
    `## ${task.description}`,
    "",
    `**Status:** ${task.status}`,
    `**Priority:** ${task.priority}`,
    `**Created:** ${task.created}`,
    "",
    "### Progress",
    ...task.progress.map((p) => `- ${p}`),
    "",
    "---",
    "*Managed by task tools*",
  ].join("\n");

  await fs.writeFile(filePath, content, "utf-8");
}

export async function readCurrentTaskId(workspaceDir: string): Promise<string | null> {
  const filePath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const match = content.match(/^\*\*Focus:\*\*\s+(task_[a-z0-9_]+)\s*$/im);
    if (!match) {
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}

export async function hasActiveTasks(workspaceDir: string): Promise<boolean> {
  const tasks = await listTasks(workspaceDir);
  return tasks.some(
    (t) => t.status === "in_progress" || t.status === "pending" || t.status === "pending_approval",
  );
}

export async function isAgentUsingTaskTools(workspaceDir: string): Promise<boolean> {
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  try {
    const files = await fs.readdir(tasksDir);
    return files.some((f) => f.startsWith("task_") && f.endsWith(".md"));
  } catch {
    return false;
  }
}
