import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { RuntimeEnv } from "../runtime.js";
import {
  controlSupervisedTask,
  SupervisedTaskControlSchema,
} from "../tasks/supervised-task.controls.js";
import {
  cancelSupervisedTask,
  createSupervisedTask,
  findCurrentTaskSupervisor,
  getSupervisedTask,
  inspectTaskSupervision,
  listSupervisedTasks,
  resumeSupervisedTask,
} from "../tasks/supervised-task.store.js";
import { SupervisedGoalSchema, SupervisedPolicySchema } from "../tasks/supervised-task.types.js";
import { getSupervisedTaskView } from "../tasks/supervised-task.view.js";
import { startSupervisedTaskWorker } from "../tasks/supervised-task.worker.js";
import { SupervisedWorkflowContractSchema } from "../tasks/supervised-workflow.types.js";

const DefinitionSchema = z.strictObject({
  flowId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  authProfileId: z.string().trim().min(1).max(128).optional(),
  runtime: z.enum(["codex", "claude-cli"]),
  prompt: z.string().trim().min(1).max(4096),
  goal: SupervisedGoalSchema.optional(),
  policy: SupervisedPolicySchema,
  workflow: SupervisedWorkflowContractSchema.optional(),
});
const ResponseSchema = z.strictObject({
  episode: z.number().int().positive(),
  input: z.string().trim().min(1).max(4096),
  policy: SupervisedPolicySchema,
});

async function readDefinition(filename: string): Promise<unknown> {
  const handle = await open(filename, "r");
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("Task definition must be a regular file");
    }
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) {
        break;
      }
      size += bytesRead;
    }
    if (size > 64 * 1024) {
      throw new Error("Task definition exceeds 64 KiB");
    }
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function print(runtime: RuntimeEnv, value: unknown) {
  runtime.log(JSON.stringify(value, null, 2));
}

function requireSupervisor(): string {
  const ownerId = findCurrentTaskSupervisor(Date.now());
  if (!ownerId) {
    throw new Error(
      "No supervisor is armed. Start `openclaw tasks supervise work`, or use `run` for foreground supervision.",
    );
  }
  return ownerId;
}

async function startWorker(runtime: RuntimeEnv, onlyFlowId?: string, canObserve?: () => boolean) {
  const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
    await import("../tasks/supervised-task.agent.js");
  await prepareSupervisedAgentRuntime();
  return startSupervisedTaskWorker({
    onlyFlowId,
    canObserve,
    runAttempt: runSupervisedAgentAttempt,
    onError: () =>
      runtime.error(
        "Supervised task worker reported an error; inspect the recorded endpoint and attempt transcript.",
      ),
    onChange: (task) =>
      print(runtime, {
        flowId: task.flowId,
        episode: task.episode,
        phase: task.phase,
        endpoint: task.endpoint,
      }),
  });
}

async function keepWorkerAlive(
  worker: Awaited<ReturnType<typeof startWorker>>,
  done: () => boolean,
) {
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    worker.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!worker.stopped && !done()) {
      await delay(250);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    worker.stop();
  }
  return interrupted;
}

export async function workSupervisedTasksCommand(runtime: RuntimeEnv): Promise<void> {
  for (;;) {
    const worker = await startWorker(runtime);
    print(runtime, {
      supervisorId: worker.ownerId,
      status: "armed",
      heartbeatMs: 1000,
      freshnessMs: 10_000,
    });
    if (await keepWorkerAlive(worker, () => false)) {
      return;
    }
    // A lost lease cannot renew its tombstone. Replace the native owner rather
    // than silently ending the daemon with queued work still awaiting custody.
    // Failed readmission throws through the CLI failure owner (nonzero exit).
    runtime.error("Supervisor stopped unexpectedly; replacing its continuation owner.");
    await delay(1000);
  }
}

export async function startSupervisedTaskCommand(
  filename: string,
  foreground: boolean,
  runtime: RuntimeEnv,
): Promise<void> {
  const definition = DefinitionSchema.parse(await readDefinition(filename));
  definition.flowId ??= randomUUID();
  // Advertise admission custody without touching an existing task with this ID.
  // Only this invocation's successful create opens observation and dispatch.
  let admitted = false;
  const worker = foreground
    ? await startWorker(runtime, definition.flowId, () => admitted)
    : undefined;
  try {
    const task = createSupervisedTask(
      definition,
      worker?.ownerId ?? requireSupervisor(),
      Date.now(),
    );
    admitted = true;
    print(runtime, inspectTaskSupervision(task.flowId, Date.now()));
    if (worker) {
      await keepWorkerAlive(worker, () => Boolean(getSupervisedTask(task.flowId)?.endpoint));
      const final = getSupervisedTask(task.flowId);
      print(runtime, inspectTaskSupervision(task.flowId, Date.now()));
      if (!final?.endpoint || (final.phase !== "succeeded" && final.phase !== "partial")) {
        process.exitCode = 1;
      }
    }
  } finally {
    worker?.stop();
  }
}

export function listSupervisedTasksCommand(runtime: RuntimeEnv): void {
  print(runtime, listSupervisedTasks());
}

export function showSupervisedTaskCommand(flowId: string, runtime: RuntimeEnv): void {
  const status = inspectTaskSupervision(flowId, Date.now());
  if (!status) {
    throw new Error("Unknown supervised TaskFlow");
  }
  print(runtime, status);
}

export function cancelSupervisedTaskCommand(flowId: string, runtime: RuntimeEnv): void {
  print(runtime, cancelSupervisedTask(flowId, Date.now()));
}

export async function resumeSupervisedTaskCommand(
  flowId: string,
  filename: string,
  runtime: RuntimeEnv,
): Promise<void> {
  const response = ResponseSchema.parse(await readDefinition(filename));
  print(
    runtime,
    resumeSupervisedTask(
      flowId,
      response.episode,
      response.input,
      response.policy,
      requireSupervisor(),
      Date.now(),
    ),
  );
}

/** Local CLI is the operator authority; request files cannot choose that actor. */
export async function controlSupervisedTaskCommand(
  filename: string,
  runtime: RuntimeEnv,
): Promise<void> {
  const request = SupervisedTaskControlSchema.parse(await readDefinition(filename));
  controlSupervisedTask(
    request,
    {
      actorId: "local-operator",
      assertCurrent: () => {},
      supervisorOwnerId:
        request.action.kind === "resume" ? findCurrentTaskSupervisor(Date.now()) : undefined,
    },
    Date.now(),
  );
  print(runtime, getSupervisedTaskView(request.flowId, Date.now()));
}
