import { createSandboxPersistentExecOwner } from "../agents/sandbox/persistent-exec.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronStoreKey } from "../cron/store/key.js";
import { cronStreamScheduleKey } from "../cron/stream-schedule.js";
import type { CronStoredJob } from "../cron/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { CronStreamOwnerParams } from "./cron-stream-owner-types.js";
import { prepareCronStreamSandboxAuthority } from "./cron-stream-sandbox-authority.js";

/** Adapts the cron source owner to the sandbox's persistent-process custody owner. */
export function createCronStreamSandboxExecutor(params: {
  scheduler: GatewayScheduler;
  storePath: string;
  storeKey?: string;
  getRuntimeConfig: () => OpenClawConfig;
  getJob: (id: string) => CronStoredJob | undefined;
  assertCurrent: () => void;
}) {
  const storeKey = params.storeKey ?? cronStoreKey(params.storePath);
  const execution = createSandboxPersistentExecOwner({ scheduler: params.scheduler });
  const spawn: NonNullable<CronStreamOwnerParams["spawnSandboxSource"]> = async (input) => {
    const { job } = input;
    const sourceIdentity = job.state.streamSourceIdentity;
    if (!job.streamSandbox || !sourceIdentity) {
      throw new Error("Sandbox stream is missing its saved target or source identity.");
    }
    const scheduleKey = cronStreamScheduleKey(job.schedule, job.streamSandbox);
    const assertCurrent = () => {
      params.assertCurrent();
      input.assertCurrent();
      const current = params.getJob(job.id);
      if (
        !current?.enabled ||
        current.schedule.kind !== "stream" ||
        current.state.streamRestartExhausted ||
        current.state.streamSourceIdentity !== sourceIdentity ||
        cronStreamScheduleKey(current.schedule, current.streamSandbox) !== scheduleKey
      ) {
        throw new Error("Sandbox stream source changed before execution.");
      }
    };
    const authority = await prepareCronStreamSandboxAuthority({
      job,
      getRuntimeConfig: params.getRuntimeConfig,
      assertCurrent,
      signal: input.signal,
    });
    try {
      authority.assertCurrent();
      const backend = authority.sandbox.backend;
      if (!backend) {
        throw new Error("The admitted sandbox has no execution backend.");
      }
      return await execution.start({
        ownerKey: `cron:${storeKey}:${job.id}`,
        source: { storeKey, jobId: job.id, scheduleKey, sourceIdentity },
        backend,
        argv: job.schedule.command,
        cwd: job.schedule.cwd ?? authority.sandbox.containerWorkdir,
        assertCurrent: authority.assertCurrent,
        signal: authority.signal,
        onOutput: input.onOutput,
        releaseAuthority: authority.release,
      });
    } catch (error) {
      authority.release();
      throw error;
    }
  };
  return { spawn, recover: execution.recover };
}
