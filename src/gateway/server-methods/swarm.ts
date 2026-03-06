import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { defaultRuntime } from "../../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

// Task registry types matching ~/.openclaw/agent-tasks.json schema
export type SwarmTaskStatus = "running" | "done" | "failed";

/** A session that should receive notifications when this task reaches key milestones. */
export type SwarmWatcher = {
  type: "session";
  sessionKey: string;
  label?: string;
};

/** Tracks which notifications have already been sent (idempotency flags). */
export type SwarmTaskNotified = {
  prCreated?: boolean;
  completed?: boolean;
};

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
  /** Sessions to notify when task.pr is first set (PR created) or task completes. */
  watchers?: SwarmWatcher[];
  /** Idempotency flags — prevents duplicate notifications per event. */
  notified?: SwarmTaskNotified;
};

type AgentTaskRegistry = {
  tasks: SwarmTask[];
};

// Use getter functions so os.homedir() is resolved at call-time, not module-load time.
// This lets tests override HOME before each test without patching a frozen constant.
function getRegistryPath(): string {
  return path.join(os.homedir(), ".openclaw", "agent-tasks.json");
}

function getSwarmScriptsDir(): string {
  return path.join(os.homedir(), "gilfoyle", "skills", "coder-swarm", "scripts");
}

function loadTaskRegistry(registryPath = getRegistryPath()): AgentTaskRegistry | null {
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    return JSON.parse(raw) as AgentTaskRegistry;
  } catch {
    return null;
  }
}

function saveTaskRegistry(registry: AgentTaskRegistry, registryPath = getRegistryPath()): void {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write via temp file
  const tmp = `${registryPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(tmp, registryPath);
}

// ---------------------------------------------------------------------------
// Notification helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Callback type injected into deliverWatcherNotifications for testability. */
export type SendToSessionFn = (sessionKey: string, message: string) => Promise<void>;

/** Build the human-readable notification message for a watcher. */
export function buildWatcherNotificationMessage(
  task: SwarmTask,
  event: "prCreated" | "completed",
): string {
  const lines: string[] = [];

  if (event === "prCreated") {
    lines.push(`🔔 Swarm task PR created: ${task.description}`);
    if (task.pr) {
      lines.push(`PR: #${task.pr}`);
    }
  } else {
    const statusEmoji = task.status === "done" ? "✅" : "⚠️";
    lines.push(`${statusEmoji} Swarm task ${task.status}: ${task.description}`);
    if (task.pr) {
      lines.push(`PR: #${task.pr}`);
    }
    if (task.note) {
      lines.push(`Note: ${task.note}`);
    }
  }

  lines.push(`Task ID: ${task.id}`);
  return lines.join("\n");
}

/**
 * Deliver watcher notifications for a given task event.
 * Idempotent: skips delivery if the event flag is already set.
 * Returns counts of delivered/skipped sessions for the caller to log.
 */
export async function deliverWatcherNotifications(opts: {
  taskId: string;
  event: "prCreated" | "completed";
  registryPath?: string;
  sendToSession: SendToSessionFn;
}): Promise<{ delivered: string[]; skipped: string }> {
  const { taskId, event, registryPath = getRegistryPath(), sendToSession } = opts;

  const registry = loadTaskRegistry(registryPath);
  if (!registry) {
    return { delivered: [], skipped: "no registry" };
  }

  const task = registry.tasks?.find((t) => t.id === taskId);
  if (!task) {
    return { delivered: [], skipped: "task not found" };
  }

  // Idempotency: skip if already notified for this event
  const alreadyNotified =
    event === "prCreated" ? task.notified?.prCreated : task.notified?.completed;
  if (alreadyNotified) {
    return { delivered: [], skipped: "already notified" };
  }

  const watchers = task.watchers ?? [];
  if (watchers.length === 0) {
    return { delivered: [], skipped: "no watchers" };
  }

  const message = buildWatcherNotificationMessage(task, event);

  const delivered: string[] = [];
  for (const watcher of watchers) {
    if (watcher.type === "session" && watcher.sessionKey) {
      try {
        await sendToSession(watcher.sessionKey, message);
        delivered.push(watcher.sessionKey);
      } catch {
        // Don't abort remaining deliveries if one watcher session fails
      }
    }
  }

  // Mark as notified in the registry (idempotency flag)
  if (delivered.length > 0) {
    const updated: AgentTaskRegistry = {
      ...registry,
      tasks: registry.tasks.map((t) => {
        if (t.id !== taskId) {
          return t;
        }
        return {
          ...t,
          notified: {
            ...t.notified,
            ...(event === "prCreated" ? { prCreated: true } : { completed: true }),
          },
        };
      }),
    };
    saveTaskRegistry(updated, registryPath);
  }

  return { delivered, skipped: "" };
}

// ---------------------------------------------------------------------------
// Gateway handlers
// ---------------------------------------------------------------------------

export const swarmHandlers: GatewayRequestHandlers = {
  /**
   * List coder-swarm tasks from ~/.openclaw/agent-tasks.json.
   * Params: { status?: "running" | "done" | "all" }
   * Returns: { tasks: Array<SwarmTask & { watcherCount: number }>, total: number }
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

    // Expose watcherCount but do not leak session keys to UI
    const tasksWithCount = tasks.map((t) => {
      const { watchers, ...rest } = t;
      return { ...rest, watcherCount: watchers?.length ?? 0 };
    });

    respond(true, { tasks: tasksWithCount, total: registry.tasks?.length ?? 0 }, undefined);
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

    const cleanupScript = path.join(getSwarmScriptsDir(), "swarm-cleanup.sh");
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

  /**
   * Spawn a new coder-swarm task via spawn-agent.sh.
   * Params: { task: string, agent?: string, repo: string, host?: string, watchers?: SwarmWatcher[] }
   * Returns: { ok: true, taskId: string, tmuxSession: string }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"4","method":"swarm.spawn","params":{"task":"...","repo":"/path","watchers":[{"type":"session","sessionKey":"agent:main:main"}]}}'
   */
  "swarm.spawn": async ({ params, respond }) => {
    const taskDesc = typeof params?.task === "string" ? params.task.trim() : "";
    const agent = typeof params?.agent === "string" ? params.agent.trim() : "codex";
    const repo = typeof params?.repo === "string" ? params.repo.trim() : "";
    const host = typeof params?.host === "string" ? params.host.trim() : "auto";

    if (!taskDesc) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task is required"));
      return;
    }
    if (!repo) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "repo is required"));
      return;
    }

    // Validate watchers if provided
    const rawWatchers = params?.watchers;
    let watchers: SwarmWatcher[] = [];
    if (rawWatchers !== undefined) {
      if (!Array.isArray(rawWatchers)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "watchers must be an array"),
        );
        return;
      }
      for (const w of rawWatchers) {
        if (
          !w ||
          typeof w !== "object" ||
          (w as SwarmWatcher).type !== "session" ||
          typeof (w as SwarmWatcher).sessionKey !== "string"
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "each watcher must have type='session' and sessionKey",
            ),
          );
          return;
        }
        watchers.push({
          type: "session",
          sessionKey: (w as SwarmWatcher).sessionKey,
          label:
            typeof (w as SwarmWatcher).label === "string" ? (w as SwarmWatcher).label : undefined,
        });
      }
    }

    const spawnScript = path.join(getSwarmScriptsDir(), "orchestrator", "bin", "spawn-agent.sh");
    const args = ["--task", taskDesc, "--agent", agent, "--repo", repo, "--host", host];

    if (watchers.length > 0) {
      args.push("--watchers", JSON.stringify(watchers));
    }

    try {
      const { stdout, stderr } = await execFileAsync(spawnScript, args, {
        timeout: 60_000,
      });

      const output = stdout + (stderr ? `\n${stderr}` : "");

      // Parse task ID from spawn-agent.sh output
      // Output format: "==> Task registered: <taskId>"
      const taskIdMatch = output.match(/Task registered:\s*(\S+)/);
      const taskId = taskIdMatch?.[1] ?? "";
      const tmuxSession = taskId ? `agent-${taskId}` : "";

      respond(true, { ok: true, taskId, tmuxSession, output: output.trim() || null }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `spawn-agent failed: ${message}`),
      );
    }
  },

  /**
   * Notify watchers of a task event (PR created or task completed/failed).
   * Idempotent: repeated calls for the same event are no-ops.
   * Called by check-agents.sh via curl when it detects these events.
   *
   * Params: { taskId: string, event: "prCreated" | "completed" }
   * Returns: { ok: true, delivered: string[], skipped: string }
   *
   * curl -s -X POST http://localhost:18789 \
   *   -H 'Content-Type: application/json' \
   *   -d '{"type":"req","id":"5","method":"swarm.notifyWatchers","params":{"taskId":"agent-task-xxx","event":"prCreated"}}'
   */
  "swarm.notifyWatchers": async ({ params, respond, context }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    const event = typeof params?.event === "string" ? params.event.trim() : "";

    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }
    if (event !== "prCreated" && event !== "completed") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, 'event must be "prCreated" or "completed"'),
      );
      return;
    }

    // sendToSession: deliver the notification as an internal message to a session
    const sendToSession: SendToSessionFn = async (sessionKey, message) => {
      await agentCommandFromIngress(
        {
          message,
          sessionKey,
          senderIsOwner: false,
          deliver: false,
          bestEffortDeliver: false,
          messageChannel: INTERNAL_MESSAGE_CHANNEL,
          runContext: { messageChannel: INTERNAL_MESSAGE_CHANNEL },
        },
        defaultRuntime,
        context.deps,
      );
    };

    const result = await deliverWatcherNotifications({
      taskId,
      event: event,
      sendToSession,
    });

    respond(true, { ok: true, ...result }, undefined);
  },
};
