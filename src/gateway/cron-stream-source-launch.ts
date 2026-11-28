import { assertCronHumanOwner } from "../cron/human-owner.js";
import { ownsStreamSource } from "../cron/stream-schedule.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import type { CronStreamJob } from "./cron-stream-output.js";
import { jobScopeKey } from "./cron-stream-owner-state.js";
import type { CronStreamOwnerParams } from "./cron-stream-owner-types.js";

export function spawnCronStreamSource(params: {
  job: CronStreamJob;
  scheduleKey: string;
  sourceIdentity: string;
  owner: Pick<CronStreamOwnerParams, "getJob" | "spawnSandboxSource">;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onSandboxOutput: (channel: "stdout" | "stderr", chunk: Buffer) => void;
  onHostOutput: (channel: "stdout" | "stderr", chunk: string) => void;
  acquireHostSupervisor: () => ProcessSupervisor;
}): Promise<ManagedRun> {
  const { job, owner, scheduleKey, sourceIdentity } = params;
  const assertCurrent = () => {
    const current = owner.getJob ? owner.getJob(job.id) : job;
    if (
      !params.isCurrent() ||
      !current?.enabled ||
      !ownsStreamSource(current, scheduleKey, sourceIdentity)
    ) {
      throw new Error("Stream source admission is no longer current.");
    }
    return current;
  };
  const assertLaunch = () => assertCronHumanOwner(assertCurrent());
  if (job.streamSandbox) {
    if (!owner.spawnSandboxSource) {
      throw new Error("Sandbox stream execution is unavailable; no host process was started.");
    }
    return owner.spawnSandboxSource({
      job,
      assertCurrent,
      assertLaunch,
      signal: params.signal,
      onOutput: params.onSandboxOutput,
    });
  }
  return params.acquireHostSupervisor().spawn({
    assertCurrent,
    initiateSpawn: (launch) => {
      assertLaunch();
      return launch();
    },
    scopeKey: jobScopeKey(job.id),
    replaceExistingScope: true,
    mode: "child",
    argv: job.schedule.command,
    ...(job.schedule.cwd ? { cwd: job.schedule.cwd } : {}),
    env: markOpenClawExecEnv({ ...process.env }),
    stdinMode: "pipe-closed",
    captureOutput: false,
    onStdout: (chunk) => params.onHostOutput("stdout", chunk),
    onStderr: (chunk) => params.onHostOutput("stderr", chunk),
  });
}
