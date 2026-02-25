import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

// Task registry types matching ~/.openclaw/agent-tasks.json schema
export type SwarmTaskStatus = "running" | "done" | "failed";

export type SwarmTask = {
  id: string;
  agent: string;
  repo: string;
  branch: string;
  worktree: string;
  host: string;
  tmuxSession: string;
  description: string;
  startedAt: number;
  status: SwarmTaskStatus;
  notifyOnComplete?: boolean;
  pr?: number;
  checks?: { ciPassed?: boolean };
  completedAt?: number;
  note?: string;
};

type AgentTaskRegistry = {
  tasks: SwarmTask[];
};

const TASK_REGISTRY_PATH = path.join(os.homedir(), ".openclaw", "agent-tasks.json");

// Swarm cleanup script location (installed by coder-swarm skill)
const SWARM_SCRIPTS_DIR = path.join(os.homedir(), "gilfoyle", "skills", "coder-swarm", "scripts");

function loadTaskRegistry(): AgentTaskRegistry | null {
  try {
    const raw = fs.readFileSync(TASK_REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as AgentTaskRegistry;
  } catch {
    return null;
  }
}

export const swarmHandlers: GatewayRequestHandlers = {
  /**
   * List coder-swarm tasks from ~/.openclaw/agent-tasks.json.
   * Params: { status?: "running" | "done" | "all" }
   * Returns: { tasks: SwarmTask[], total: number }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"1","method":"swarm.list","params":{"status":"running"}}'
   */
  "swarm.list": ({ params, respond }) => {
    const statusFilter = typeof params?.status === "string" ? params.status.trim() : "all";

    const registry = loadTaskRegistry();
    if (!registry) {
      // Registry not yet created — return empty list rather than an error
      respond(true, { tasks: [], total: 0 }, undefined);
      return;
    }

    let tasks = registry.tasks ?? [];
    if (statusFilter === "running") {
      tasks = tasks.filter((t) => t.status === "running");
    } else if (statusFilter === "done") {
      tasks = tasks.filter((t) => t.status === "done" || t.status === "failed");
    }
    // "all" returns unfiltered list

    respond(true, { tasks, total: registry.tasks?.length ?? 0 }, undefined);
  },

  /**
   * Kill / clean up a coder-swarm task via swarm-cleanup.sh.
   * Params: { taskId: string, force?: boolean }
   * Returns: { ok: true, taskId: string, output: string | null }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"2","method":"swarm.kill","params":{"taskId":"agent-task-xxx","force":false}}'
   */
  "swarm.kill": async ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }

    const force = params?.force === true;

    // Verify task exists before invoking cleanup script
    const registry = loadTaskRegistry();
    if (!registry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "task registry not found"));
      return;
    }

    const task = registry.tasks?.find((t) => t.id === taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    const cleanupScript = path.join(SWARM_SCRIPTS_DIR, "swarm-cleanup.sh");
    const args = force ? [taskId, "--force"] : [taskId];

    try {
      const { stdout, stderr } = await execFileAsync(cleanupScript, args, {
        timeout: 30_000,
      });
      const output = stdout.trim() || stderr.trim() || null;
      respond(true, { ok: true, taskId, output }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `swarm-cleanup failed: ${message}`),
      );
    }
  },

  /**
   * Fetch tmux pane output for a running coder-swarm task.
   * Params: { taskId: string, lines?: number }
   * Returns: { taskId, tmuxSession, task, logs: string | null, error: string | null }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"3","method":"swarm.logs","params":{"taskId":"agent-task-xxx","lines":200}}'
   */
  "swarm.logs": async ({ params, respond }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }

    const maxLines =
      typeof params?.lines === "number" && Number.isFinite(params.lines)
        ? Math.min(Math.max(1, Math.floor(params.lines)), 5000)
        : 500;

    const registry = loadTaskRegistry();
    if (!registry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "task registry not found"));
      return;
    }

    const task = registry.tasks?.find((t) => t.id === taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }

    const { tmuxSession } = task;
    let logs: string | null = null;
    let logsError: string | null = null;

    try {
      // tmux capture-pane -p prints the visible pane content; -S -N scrolls back N lines
      const { stdout } = await execFileAsync(
        "tmux",
        ["capture-pane", "-p", "-t", tmuxSession, "-S", String(-maxLines)],
        { timeout: 10_000 },
      );
      logs = stdout;
    } catch (err) {
      // Session may no longer exist (task finished and was cleaned up)
      logsError = err instanceof Error ? err.message : String(err);
    }

    respond(
      true,
      {
        taskId,
        tmuxSession,
        task: {
          id: task.id,
          agent: task.agent,
          status: task.status,
          description: task.description,
          startedAt: task.startedAt,
          completedAt: task.completedAt ?? null,
          pr: task.pr ?? null,
          repo: task.repo,
          branch: task.branch,
        },
        logs,
        error: logsError,
      },
      undefined,
    );
  },
};
