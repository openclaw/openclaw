import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runtimeMutation from "../cron/service/runtime-mutation.js";
import { loadCronStore } from "../cron/store.js";
import type { CronJobCreate } from "../cron/types.js";
import type {
  AddCronJob,
  CronFixture,
  registerGatewayCronContextTests,
} from "./server-cron.context.test-support.js";
import type { createWatchedRun as createWatchedRunFixture } from "./server-cron.process.test-support.js";

type ContextHarness = Parameters<typeof registerGatewayCronContextTests>[0];
type CronMutationHarness = Pick<ContextHarness, "createCronConfig" | "createCronService"> & {
  loadCronService: ContextHarness["createCronService"];
  addCronJob: (
    service: CronFixture,
    name: string,
    payload: CronJobCreate["payload"],
    overrides?: Parameters<AddCronJob>[3],
  ) => ReturnType<AddCronJob>;
};

async function withHeldMutation<T>(
  mutate: () => Promise<T>,
  check: (held: { release: () => void; result: Promise<T> }) => Promise<void>,
) {
  const entered = createDeferred();
  const release = createDeferred();
  const execute = runtimeMutation.runCronRuntimeMutation;
  const held = vi
    .spyOn(runtimeMutation, "runCronRuntimeMutation")
    .mockImplementation(async (params) => {
      if (params.type !== "cron.mutateJobs") {
        return execute(params);
      }
      held.mockRestore();
      entered.resolve();
      await release.promise;
      return execute(params);
    });
  const result = mutate();
  // Attach rejection observation before the gate opens; the check owns the assertion.
  void result.catch(() => {});
  try {
    await entered.promise;
    await check({ release: () => release.resolve(), result });
  } finally {
    release.resolve();
    await result.catch(() => {});
    held.mockRestore();
  }
}

async function readStoredJob(state: CronFixture, id: string) {
  return (await loadCronStore(state.storePath)).jobs.find((job) => job.id === id);
}

export function registerGatewayCronMutationAuthorityTests(harness: CronMutationHarness) {
  it.each(["update", "updateWithPrecondition"] as const)(
    "forwards authority options through the %s lifecycle wrapper",
    async (method) => {
      const cfg = harness.createCronConfig(`server-cron-update-authority-${method}`);
      const state = harness.loadCronService(cfg);
      const owner = {
        agentId: "main",
        sessionKey: "agent:main:discord:group:ops",
        accountId: "work",
      };
      const scheduledToolPolicy = {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
      const runtimeAuthority = {
        version: 1 as const,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      let current = true;
      const commitGuard = () => {
        if (!current) {
          throw new Error("authority revoked during worker admission");
        }
      };
      const captureRuntimeAuthority = vi.fn(() => runtimeAuthority);
      const precondition = vi.fn(() => undefined);
      const options = { scheduledToolPolicy, commitGuard, captureRuntimeAuthority };
      let restarted: CronFixture | undefined;
      try {
        const job = await harness.addCronJob(
          state,
          `authority ${method}`,
          { kind: "systemEvent", text: "run" },
          {
            owner,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "now",
          },
        );
        const update = (next: Parameters<CronFixture["cron"]["update"]>[1]) =>
          method === "update"
            ? state.cron.update(job.id, next, options)
            : state.cron.updateWithPrecondition(job.id, next, precondition, options);
        const expectCaptured = () => {
          expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
          if (method === "updateWithPrecondition") {
            expect(precondition).toHaveBeenCalledOnce();
          }
        };
        await update({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "updated", toolsAllow: ["write"] },
        });
        expectCaptured();
        const committed = expectDefined(await readStoredJob(state, job.id), "authority job");
        expect([committed.scheduledToolPolicy, committed.runtimeAuthority]).toEqual([
          scheduledToolPolicy,
          runtimeAuthority,
        ]);

        captureRuntimeAuthority.mockClear();
        precondition.mockClear();
        await withHeldMutation(
          () => update({ name: "must not commit" }),
          async ({ release, result }) => {
            current = false;
            release();
            await expect(result).rejects.toThrow("authority revoked");
            expectCaptured();
            expect(await readStoredJob(state, job.id)).toEqual(committed);
          },
        );
        state.cron.stop();
        restarted = harness.createCronService(cfg);
        expect((await restarted.cron.readJob(job.id))?.scheduledToolPolicy).toEqual(
          scheduledToolPolicy,
        );
      } finally {
        state.cron.stop();
        restarted?.cron.stop();
      }
    },
  );
}

type StreamMutationHarness = Pick<CronMutationHarness, "createCronConfig" | "loadCronService"> & {
  addSystemEventJob: AddCronJob;
  createWatchedRun: typeof createWatchedRunFixture;
  mockCronSupervisor: (...runs: ReturnType<typeof createWatchedRunFixture>[]) => {
    cancelScope: Mock;
  };
};

export function registerGatewayCronStreamMutationTests(harness: StreamMutationHarness) {
  it("reports a committed stream update as successful when source teardown fails", async () => {
    vi.useFakeTimers();
    const watched = harness.createWatchedRun(true, { durationMs: 10_000 });
    const canceled = createDeferred();
    watched.cancel.mockImplementationOnce(() => canceled.resolve());
    const { cancelScope } = harness.mockCronSupervisor(watched);
    const cfg = harness.createCronConfig("server-cron-stream-update-teardown-failure");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = harness.loadCronService(cfg);
    try {
      const added = await harness.addSystemEventJob(
        state,
        "stubborn update stream source",
        "event",
        {
          schedule: { kind: "stream", command: ["source"] },
          sessionTarget: "main",
        },
      );
      const streamJob = "job" in added ? added.job : added;
      await withHeldMutation(
        () => state.cron.update(streamJob.id, { enabled: false }),
        async ({ release, result }) => {
          await canceled.promise;
          cancelScope.mockClear();
          // The stop deadline settles while the durable write is still pending.
          await vi.advanceTimersByTimeAsync(30_000);
          expect(cancelScope).toHaveBeenCalledWith(`cron-stream:${streamJob.id}`, "manual-cancel");
          expect(state.cron.getJob(streamJob.id)?.enabled).toBe(true);
          release();
          await expect(result).resolves.toMatchObject({ enabled: false });
          expect((await readStoredJob(state, streamJob.id))?.enabled).toBe(false);
          expect(watched.cancel).toHaveBeenCalled();
        },
      );
    } finally {
      try {
        await state.stopStreamWatchers?.();
      } finally {
        state.cron.stop();
        vi.useRealTimers();
      }
    }
  });
}
