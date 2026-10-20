import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { CronService } from "../cron/service.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { buildGatewayCronService } from "./server-cron.js";
import type * as processFixture from "./server-cron.process.test-support.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type WatchedRun = ReturnType<typeof processFixture.createWatchedRun>;
type GatewayCronHandoffTestHarness = {
  createWatchedRun: typeof processFixture.createWatchedRun;
  mockCronSupervisor: (...runs: WatchedRun[]) => {
    spawn: Mock<() => Promise<WatchedRun & { runId: string }>>;
  };
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => CronFixture;
  getConcreteCron: (service: CronFixture) => CronService;
  addSystemEventJob: (
    service: CronFixture,
    name: string,
    text: string,
    overrides?: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<CronFixture["cron"]["add"]>;
  runExit: typeof processFixture.runExit;
};

export function registerGatewayCronHandoffTests({
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
  getConcreteCron,
  addSystemEventJob,
  runExit,
  requestHeartbeatAndWaitMock: wakeMock,
  enqueueSystemEventMock,
}: GatewayCronHandoffTestHarness & {
  requestHeartbeatAndWaitMock: Mock<(...args: unknown[]) => Promise<HeartbeatRunResult>>;
  enqueueSystemEventMock: Mock;
}) {
  it.each(["start", "start failure", "stop"] as const)(
    "holds adopted on-exit work until the previous scheduler drains (%s)",
    async (outcome) => {
      const watched = [createWatchedRun(false), createWatchedRun(false)] as const;
      const exits = [watched[0].exit, watched[1].exit] as const;
      const { spawn } = mockCronSupervisor(...watched);
      const heartbeat = () => {
        const entered = createDeferred();
        const release = createDeferred();
        const run = async () => {
          entered.resolve();
          await release.promise;
          return { status: "ran" as const, durationMs: 1 };
        };
        return { entered, release, run };
      };
      const first = heartbeat();
      const second = heartbeat();
      wakeMock.mockReset().mockImplementationOnce(first.run).mockImplementationOnce(second.run);
      const cfg = createCronConfig("server-cron-on-exit-handoff");
      // Only the two on-exit wakes belong to this handoff fixture.
      cfg.agents = { defaults: { heartbeat: { every: "0m" } } };
      const previous = loadCronService(cfg);
      const start =
        outcome === "start failure"
          ? vi
              .spyOn(CronService.prototype, "start")
              .mockRejectedValueOnce(new Error("start failed"))
          : undefined;
      const next = loadCronService(cfg);
      const nextRun = vi.spyOn(getConcreteCron(next), "runOnExit");
      let adoption: void | Promise<void> = undefined;
      try {
        const addJob = (name: string) =>
          addSystemEventJob(previous, name, "done", {
            schedule: { kind: "on-exit", command: "true" },
            sessionTarget: "main",
            wakeMode: "now",
          });
        await addJob("first");
        const secondJob = await addJob("second");
        await previous.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledTimes(2);
        exits[0].resolve(runExit({ reason: "exit", exitCode: 0 }));
        await first.entered.promise;
        expect(wakeMock).toHaveBeenCalledOnce();
        const oldHandoff = expectDefined(
          await previous.prepareExitWatcherHandoff?.(),
          "previous handoff",
        );
        const nextHandoff = expectDefined(await next.prepareExitWatcherHandoff?.(), "next handoff");
        adoption = nextHandoff.adopt(oldHandoff.current());
        exits[1].resolve(
          runExit({ reason: "exit", exitCode: 7, stdout: "completed before reload" }),
        );
        await waitForImmediate();
        expect(nextRun).not.toHaveBeenCalled();
        expect(wakeMock).toHaveBeenCalledOnce();

        first.release.resolve();
        await adoption;
        await oldHandoff.stopOwner();
        expect(nextRun).not.toHaveBeenCalled();
        expect(wakeMock).toHaveBeenCalledOnce();
        const secondId = secondJob.id;
        if (outcome !== "stop") {
          if (outcome === "start failure") {
            await expect(next.cron.start()).rejects.toThrow("start failed");
            expect(wakeMock).toHaveBeenCalledOnce();
          }
          await next.cron.start();
          await second.entered.promise;
          expect(wakeMock).toHaveBeenCalledTimes(2);
          expect(nextRun).toHaveBeenCalledOnce();
          expect(wakeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ reason: "cron:" + secondId }),
            expect.anything(),
          );
          second.release.resolve();
          expect(nextRun.mock.results[0]?.type).toBe("return");
          await nextRun.mock.results[0]?.value;
          expect(next.cron.getJob(secondId)?.state.lastRunStatus).toBe("ok");
          expect(enqueueSystemEventMock).toHaveBeenLastCalledWith(
            expect.stringContaining("completed before reload"),
            expect.anything(),
          );
          expect(spawn).toHaveBeenCalledTimes(2);
        } else {
          await next.cron.stopAndDrain?.();
          expect(wakeMock).toHaveBeenCalledOnce();
          expect(
            (await next.cron.list({ includeDisabled: true })).find((job) => job.id === secondId)
              ?.enabled,
          ).toBe(true);
          expect(nextHandoff.current().activeJobIds()).toEqual([]);
        }
      } finally {
        first.release.resolve();
        second.release.resolve();
        for (const exit of exits) {
          exit.resolve(runExit());
        }
        try {
          await adoption;
          await next.cron.stopAndDrain?.();
          await previous.cron.stopAndDrain?.();
        } finally {
          nextRun.mockRestore();
          start?.mockRestore();
          // The stop case deliberately leaves its second heartbeat unconsumed.
          wakeMock.mockReset();
        }
      }
    },
  );
}
