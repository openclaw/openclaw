import { agentCommand } from "../agents/agent-command.js";
import { createDefaultDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  CHIEF_TASK_STALE_AFTER_MS,
  listStaleChiefTasks,
  markChiefTaskResumeRequested,
  recordChiefTaskFailure,
  recordChiefTaskResult,
  type ChiefTaskRecord,
} from "./chief-task-ledger.js";

export const DEFAULT_CHIEF_CONTINUATION_CHECK_MS = 60_000;

const log = createSubsystemLogger("chief/continuation-runner");

export type ChiefContinuationRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function buildChiefContinuationPrompt(task: ChiefTaskRecord): string {
  const lines = [
    "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.",
    "Do not start unrelated work.",
    "",
    `Task ID: ${task.taskId}`,
    `Source: ${task.source}`,
    `Session: ${task.sessionKey}`,
    `Task summary: ${task.title}`,
    `Original request: ${task.promptPreview}`,
  ];
  if (task.lastResponsePreview) {
    lines.push(`Last response preview: ${task.lastResponsePreview}`);
  }
  if (task.lastError) {
    lines.push(`Last error: ${task.lastError}`);
  }
  lines.push(
    "",
    "If the task is already complete, provide the final answer only once.",
    "If the task is blocked or waiting for input, say exactly what is missing.",
  );
  return lines.join("\n");
}

export function startChiefContinuationRunner(opts: {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  nowMs?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  getQueueSize?: (lane?: string) => number;
  listStaleTasks?: typeof listStaleChiefTasks;
  markResumeRequested?: typeof markChiefTaskResumeRequested;
  recordTaskResult?: typeof recordChiefTaskResult;
  recordTaskFailure?: typeof recordChiefTaskFailure;
  runChief?: typeof agentCommand;
}): ChiefContinuationRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const intervalMs = Math.max(5_000, opts.intervalMs ?? DEFAULT_CHIEF_CONTINUATION_CHECK_MS);
  const staleAfterMs = Math.max(60_000, opts.staleAfterMs ?? CHIEF_TASK_STALE_AFTER_MS);
  const getLaneSize = opts.getQueueSize ?? getQueueSize;
  const listStaleTasks = opts.listStaleTasks ?? listStaleChiefTasks;
  const markResumeRequested = opts.markResumeRequested ?? markChiefTaskResumeRequested;
  const recordTaskResult = opts.recordTaskResult ?? recordChiefTaskResult;
  const recordTaskFailure = opts.recordTaskFailure ?? recordChiefTaskFailure;
  const runChief = opts.runChief ?? agentCommand;
  const deps = createDefaultDeps();

  let cfg = opts.cfg;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      try {
        await tick();
      } finally {
        schedule();
      }
    }, intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    if (getLaneSize(CommandLane.Main) > 0) {
      return;
    }
    running = true;
    try {
      const staleTasks = await listStaleTasks({
        cfg,
        agentId: "chief",
        nowMs: nowMs(),
        staleAfterMs,
      });
      const task = staleTasks[0];
      if (!task) {
        return;
      }
      await markResumeRequested({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        nowMs: nowMs(),
      });
      log.warn("chief continuation watchdog resuming stale task", {
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        source: task.source,
        staleForMs: nowMs() - task.lastProgressAt,
      });
      const result = await runChief(
        {
          agentId: "chief",
          sessionKey: task.sessionKey,
          message: buildChiefContinuationPrompt(task),
          deliver: true,
          senderIsOwner: true,
        },
        runtime,
        deps,
      );
      await recordTaskResult({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        payloads: result?.payloads,
        nowMs: nowMs(),
      });
    } catch (error) {
      const staleTasks = await listStaleTasks({
        cfg,
        agentId: "chief",
        nowMs: nowMs(),
        staleAfterMs,
      });
      const task = staleTasks[0];
      if (task) {
        await recordTaskFailure({
          cfg,
          agentId: "chief",
          taskId: task.taskId,
          sessionKey: task.sessionKey,
          error,
          nowMs: nowMs(),
        }).catch(() => undefined);
      }
      log.error(`chief continuation watchdog failed: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    updateConfig: (nextCfg) => {
      cfg = nextCfg;
    },
  };
}
