import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CronService } from "../cron/service.js";
import type { CronRunOutcome } from "../cron/types.js";
import type { GatewayCronReceiptTestHarness } from "./server-cron.receipts.test-support.js";

export function registerGatewayCronHandoffTests({
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
  getConcreteCron,
  addCronJob,
  runExit,
  runSessionEventMock,
}: Omit<GatewayCronReceiptTestHarness, "getCronDeps"> & {
  runSessionEventMock: Mock<(...args: unknown[]) => Promise<CronRunOutcome>>;
}) {
  it.each(["start", "start failure", "stop"] as const)(
    "holds adopted on-exit work until the previous scheduler drains (%s)",
    async (outcome) => {
      const watched = [createWatchedRun(false), createWatchedRun(false)] as const;
      const exits = [watched[0].exit, watched[1].exit] as const;
      const firstStarted = createDeferred();
      const secondStarted = createDeferred();
      const releaseFirst = createDeferred();
      const releaseSecond = createDeferred();
      const { spawn } = mockCronSupervisor(...watched);
      runSessionEventMock
        .mockReset()
        .mockImplementationOnce(async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { status: "ok", summary: "done" };
        })
        .mockImplementationOnce(async () => {
          secondStarted.resolve();
          await releaseSecond.promise;
          return { status: "ok", summary: "done" };
        });
      const cfg = createCronConfig("server-cron-on-exit-handoff");
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
        const jobs = [];
        for (const name of ["first", "second"]) {
          jobs.push(
            await addCronJob(
              previous,
              name,
              { kind: "systemEvent", text: "done" },
              {
                schedule: { kind: "on-exit", command: "true" },
                sessionTarget: "main",
                wakeMode: "now",
              },
            ),
          );
        }
        await previous.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledTimes(2);
        exits[0].resolve(runExit({ reason: "exit", exitCode: 0 }));
        await firstStarted.promise;
        expect(runSessionEventMock).toHaveBeenCalledOnce();
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
        expect(runSessionEventMock).toHaveBeenCalledOnce();

        releaseFirst.resolve();
        await adoption;
        await oldHandoff.stopOwner();
        expect(nextRun).not.toHaveBeenCalled();
        expect(runSessionEventMock).toHaveBeenCalledOnce();
        const secondId = expectDefined(jobs[1], "second job").id;
        if (outcome !== "stop") {
          if (outcome === "start failure") {
            await expect(next.cron.start()).rejects.toThrow("start failed");
            expect(runSessionEventMock).toHaveBeenCalledOnce();
          }
          await next.cron.start();
          await secondStarted.promise;
          expect(runSessionEventMock).toHaveBeenCalledTimes(2);
          expect(nextRun).toHaveBeenCalledOnce();
          expect(runSessionEventMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
              job: expect.objectContaining({ id: secondId }),
              text: expect.stringContaining("completed before reload"),
            }),
          );
          releaseSecond.resolve();
          const completion = expectDefined(nextRun.mock.results[0], "adopted on-exit run");
          if (completion.type !== "return") {
            throw new Error("Adopted on-exit run did not return a completion");
          }
          await completion.value;
          expect(next.cron.getJob(secondId)?.state.lastRunStatus).toBe("ok");
          expect(spawn).toHaveBeenCalledTimes(2);
        } else {
          await next.cron.stopAndDrain?.();
          expect(runSessionEventMock).toHaveBeenCalledOnce();
          expect(
            (await next.cron.list({ includeDisabled: true })).find((job) => job.id === secondId)
              ?.enabled,
          ).toBe(true);
          expect(nextHandoff.current().activeJobIds()).toEqual([]);
        }
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
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
          // The stop case deliberately leaves its second session execution unconsumed.
          runSessionEventMock.mockReset();
        }
      }
    },
  );
}
