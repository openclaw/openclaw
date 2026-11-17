import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronService } from "../cron/service.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { AddCronJob, CronFixture } from "./server-cron.context.test-support.js";
import { createWatchedRun, runExit } from "./server-cron.process.test-support.js";

type CronRearmHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (config: OpenClawConfig) => CronFixture;
  getCronDeps: (
    service: CronFixture,
  ) => Pick<CronServiceState["deps"], "runSessionEvent" | "nowMs">;
  getConcreteCron: (service: CronFixture) => CronService;
  mockCronSupervisor: (...runs: ReturnType<typeof createWatchedRun>[]) => { spawn: unknown };
  addSystemEventJob: AddCronJob;
};

export function registerGatewayCronRearmTests({
  createCronConfig,
  loadCronService,
  getCronDeps,
  getConcreteCron,
  mockCronSupervisor,
  addSystemEventJob,
}: CronRearmHarness) {
  it.each([
    { command: "true", exitTiming: "after" },
    { command: "echo rearmed", exitTiming: "after" },
    { command: "true", exitTiming: "before" },
    { command: "echo rearmed", exitTiming: "before" },
  ])(
    "re-arms on-exit $command when its next exit arrives $exitTiming the previous callback settles",
    async ({ command, exitTiming }) => {
      const first = createWatchedRun(false);
      const second = createWatchedRun(false);
      const firstExit = first.exit;
      const secondExit = second.exit;
      const releasePayload = createDeferred();
      const payloadFinished = createDeferred();
      const { spawn } = mockCronSupervisor(first, second);
      const runSessionEvent = vi
        .fn<NonNullable<CronServiceState["deps"]["runSessionEvent"]>>()
        .mockResolvedValue({ status: "ok" })
        .mockImplementationOnce(async () => {
          await releasePayload.promise;
          return { status: "ok" };
        });
      const state = loadCronService(createCronConfig("server-cron-on-exit-rearm"));
      getCronDeps(state).runSessionEvent = runSessionEvent;
      let nowMs = 1_700_000_000_000;
      getCronDeps(state).nowMs = () => nowMs;
      const cron = getConcreteCron(state);
      const run = cron.runOnExit.bind(cron);
      vi.spyOn(cron, "runOnExit").mockImplementationOnce(async (...args) => {
        try {
          return await run(...args);
        } finally {
          // A changed command cancels the run before its abort-ignoring payload settles.
          // Hold the watcher callback itself so both cases exercise a pending predecessor.
          await releasePayload.promise;
          payloadFinished.resolve();
        }
      });

      try {
        const job = await addSystemEventJob(state, "watch and rearm", "done", {
          schedule: { kind: "on-exit", command: "true" },
          sessionTarget: "main",
          wakeMode: "now",
        });
        await state.reconcileExitWatchers();
        firstExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
        await vi.waitFor(() => expect(runSessionEvent).toHaveBeenCalledOnce());
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        await state.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledOnce();

        const rearmed = await state.cron.update(job.id, {
          enabled: true,
          schedule: { kind: "on-exit", command },
        });
        expect(rearmed.updatedAtMs).toBe(job.updatedAtMs);
        await state.reconcileExitWatchers();
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

        if (exitTiming === "before") {
          secondExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
          await waitForImmediate();
          expect(state.cron.getJob(job.id)?.enabled).toBe(true);
          expect(runSessionEvent).toHaveBeenCalledOnce();
        }
        nowMs += 1;
        releasePayload.resolve();
        await payloadFinished.promise;
        if (exitTiming === "after") {
          await state.reconcileExitWatchers();
          expect(state.cron.getJob(job.id)?.enabled).toBe(true);
          secondExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
        }
        await vi.waitFor(() => expect(runSessionEvent).toHaveBeenCalledTimes(2));
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
      } finally {
        releasePayload.resolve();
        firstExit.resolve(runExit());
        secondExit.resolve(runExit());
        await state.cron.stopAndDrain?.();
      }
    },
  );
}
