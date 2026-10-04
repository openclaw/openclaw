import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import * as runtimeMutation from "../cron/service/runtime-mutation.js";
import { loadCronStore } from "../cron/store.js";
import type { CronJobCreate } from "../cron/types.js";
import type { RunExit } from "../process/supervisor/types.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;
type CronMutationHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => CronFixture;
  createCronService: (cfg: OpenClawConfig) => CronFixture;
  addCronJob: (
    service: CronFixture,
    name: string,
    payload: CronJobCreate["payload"],
    overrides?: CronJobOverrides,
  ) => ReturnType<CronFixture["cron"]["add"]>;
};

function holdNextCronMutation() {
  const entered = createDeferred();
  const release = createDeferred();
  const execute = runtimeMutation.runCronRuntimeMutation;
  const held = vi
    .spyOn(runtimeMutation, "runCronRuntimeMutation")
    .mockImplementationOnce(async (params) => {
      entered.resolve();
      await release.promise;
      return execute(params);
    });
  return { entered, release, restore: () => held.mockRestore() };
}

export function registerGatewayCronMutationAuthorityTests({
  createCronConfig,
  loadCronService,
  createCronService,
  addCronJob,
}: CronMutationHarness) {
  it.each(["update", "updateWithPrecondition"] as const)(
    "forwards authority options through the %s lifecycle wrapper",
    async (method) => {
      const cfg = createCronConfig(`server-cron-update-authority-${method}`);
      const state = loadCronService(cfg);
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
      let current = true;
      const commitGuard = () => {
        if (!current) {
          throw new Error("authority revoked during worker admission");
        }
      };
      const precondition = vi.fn(() => undefined);
      const options = { scheduledToolPolicy, commitGuard };
      let restarted: CronFixture | undefined;
      try {
        const job = await addCronJob(
          state,
          `authority ${method}`,
          {
            kind: "systemEvent",
            text: "run",
          },
          {
            owner,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "now",
          },
        );
        const patch = {
          sessionTarget: "isolated" as const,
          payload: { kind: "agentTurn" as const, message: "updated" },
        };
        const update = (next: Parameters<CronFixture["cron"]["update"]>[1]) =>
          method === "update"
            ? state.cron.update(job.id, next, options)
            : state.cron.updateWithPrecondition(job.id, next, precondition, options);
        await update(patch);
        if (method === "updateWithPrecondition") {
          expect(precondition).toHaveBeenCalledOnce();
        }
        const committed = expectDefined(
          (await loadCronStore(state.storePath)).jobs.find((entry) => entry.id === job.id),
          "committed authority job",
        );
        expect(committed.scheduledToolPolicy).toEqual(scheduledToolPolicy);
        precondition.mockClear();
        const held = holdNextCronMutation();
        const revoked = update({ name: "must not commit" }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await held.entered.promise;
          current = false;
          held.release.resolve();
          const result = await revoked;
          expect(result).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("authority revoked") },
          });
          if (method === "updateWithPrecondition") {
            expect(precondition).toHaveBeenCalledOnce();
          }
          expect(
            (await loadCronStore(state.storePath)).jobs.find((entry) => entry.id === job.id),
          ).toEqual(committed);
        } finally {
          held.release.resolve();
          await revoked;
          held.restore();
        }
        state.cron.stop();
        restarted = createCronService(cfg);
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

type WatchedRun = {
  exit: ReturnType<typeof createDeferred<RunExit>>;
  startedAtMs: number;
  cancel: Mock<() => void>;
  detachOutput: Mock;
  wait: Mock<() => Promise<RunExit>>;
};

export function registerGatewayCronStreamMutationTests({
  createCronConfig,
  loadCronService,
  addSystemEventJob,
  createWatchedRun,
  mockCronSupervisor,
}: Pick<CronMutationHarness, "createCronConfig" | "loadCronService"> & {
  addSystemEventJob: (
    service: CronFixture,
    name: string,
    text: string,
    overrides?: CronJobOverrides,
  ) => ReturnType<CronFixture["cron"]["add"]>;
  createWatchedRun: (settleOnCancel: boolean, exitResult: Partial<RunExit>) => WatchedRun;
  mockCronSupervisor: (...runs: WatchedRun[]) => { cancelScope: Mock };
}) {
  it("reports a committed stream update as successful when source teardown fails", async () => {
    vi.useFakeTimers();
    const watched = createWatchedRun(true, { durationMs: 10_000 });
    const canceled = createDeferred();
    watched.cancel.mockImplementationOnce(() => canceled.resolve());
    const { cancelScope } = mockCronSupervisor(watched);
    const cfg = createCronConfig("server-cron-stream-update-teardown-failure");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);
    try {
      const added = await addSystemEventJob(state, "stubborn update stream source", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
      const streamJob = "job" in added ? added.job : added;
      const held = holdNextCronMutation();
      const update = state.cron.update(streamJob.id, { enabled: false }).then(
        (job) => ({ ok: true as const, job }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await held.entered.promise;
        await canceled.promise;
        cancelScope.mockClear();
        // The original stop deadline must settle while the real write is still pending.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(cancelScope).toHaveBeenCalledWith(`cron-stream:${streamJob.id}`, "manual-cancel");
        expect(state.cron.getJob(streamJob.id)?.enabled).toBe(true);
        held.release.resolve();
        expect(await update).toMatchObject({ ok: true, job: { enabled: false } });
        expect(
          (await loadCronStore(state.storePath)).jobs.find((job) => job.id === streamJob.id)
            ?.enabled,
        ).toBe(false);
        expect(watched.cancel).toHaveBeenCalled();
      } finally {
        held.release.resolve();
        await update;
        held.restore();
      }
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
