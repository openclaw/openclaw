import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AddCronJob, CronFixture } from "./server-cron.context.test-support.js";

function holdInventory(state: CronFixture) {
  const entered = createDeferred();
  const release = createDeferred();
  const listJobs = state.cron.list.bind(state.cron);
  vi.spyOn(state.cron, "list").mockImplementationOnce(async (options) => {
    const inventory = await listJobs(options);
    entered.resolve();
    await release.promise;
    return inventory;
  });
  return { entered, release, listJobs, [Symbol.dispose]: () => release.resolve() };
}

export function registerGatewayCronSystemJobTests({
  createCronConfig,
  loadCronService,
  withCronService,
  setRuntimeConfig,
  addAgentTurnJob,
}: {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig, options?: { scheduler?: GatewayScheduler }) => CronFixture;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: CronFixture) => Promise<void>,
  ) => Promise<void>;
  setRuntimeConfig: (cfg: OpenClawConfig) => void;
  addAgentTurnJob: AddCronJob;
}) {
  const heartbeatDefaults = (every: string) => ({ defaults: { heartbeat: { every } } });
  it.each(["accepted replacement", "superseding request"] as const)(
    "converges an in-flight heartbeat inventory after %s",
    async (mode) => {
      const superseding = mode === "superseding request";
      const agents = (every: string) =>
        superseding ? heartbeatDefaults(every) : { entries: { main: { heartbeat: { every } } } };
      const cfg = { ...createCronConfig(`server-cron-${mode}`), agents: agents("1h") };
      await withCronService(cfg, async (state) => {
        await expect(state.reconcileSystemJobs()).resolves.toBe("converged");
        using held = holdInventory(state);
        const addJob = vi.spyOn(state.cron, "add");
        const removeJob = vi.spyOn(state.cron, "remove");
        if (superseding) {
          setRuntimeConfig({ ...cfg, agents: agents("0m") });
        }
        const pending = state.reconcileSystemJobs();
        await held.entered.promise;
        setRuntimeConfig(superseding ? cfg : { ...cfg, agents: agents("2h") });
        const next = superseding ? state.reconcileSystemJobs() : undefined;
        held.release.resolve();
        await expect(pending).resolves.toBe(superseding ? "superseded" : "converged");
        if (next) {
          await expect(next).resolves.toBe("converged");
          expect(addJob).not.toHaveBeenCalledWith(
            expect.objectContaining({ enabled: false }),
            expect.anything(),
          );
          expect(removeJob).not.toHaveBeenCalled();
        } else {
          expect(await held.listJobs({ includeDisabled: true })).toContainEqual(
            expect.objectContaining({
              payload: { kind: "heartbeat" },
              schedule: expect.objectContaining({ everyMs: 7_200_000 }),
            }),
          );
        }
      });
    },
  );

  it.each(["stop", "replace", "supersede"] as const)(
    "observes %s between committed heartbeat monitor mutations",
    async (action) => {
      const baseConfig = createCronConfig(`server-cron-fairness-heartbeat-${action}`);
      const cfg = {
        ...baseConfig,
        cron: { ...baseConfig.cron, enabled: false },
        agents: { ownership: "explicit", ...heartbeatDefaults("1h"), entries: { a: {}, b: {} } },
      } satisfies OpenClawConfig;
      const replacement = {
        ...cfg,
        agents: { ...cfg.agents, ...heartbeatDefaults("2h") },
      } satisfies OpenClawConfig;
      const state = loadCronService(cfg);
      const addJob = state.cron.add.bind(state.cron);
      let checkpoint: Promise<void> | undefined;
      let nextPass: ReturnType<typeof state.reconcileSystemJobs> | undefined;
      const committed: Array<{ agentId?: string; everyMs?: number }> = [];
      vi.spyOn(state.cron, "add").mockImplementation(async (input, options) => {
        const result = await addJob(input, options);
        if (input.declarationKey?.startsWith("heartbeat:")) {
          committed.push({
            agentId: input.agentId,
            everyMs: input.schedule.kind === "every" ? input.schedule.everyMs : undefined,
          });
          checkpoint ??= new Promise((resolve) => {
            setImmediate(() => {
              if (action === "stop") {
                state.cron.stop();
              } else {
                setRuntimeConfig(replacement);
                if (action === "supersede") {
                  nextPass = state.reconcileSystemJobs();
                }
              }
              resolve();
            });
          });
        }
        return result;
      });
      try {
        const result = await state.reconcileSystemJobs();
        await checkpoint;
        if (action === "stop") {
          expect(result).toBe("superseded");
          expect(committed.map(({ agentId }) => agentId)).toEqual(["a"]);
        } else {
          expect(result).toBe(action === "replace" ? "converged" : "superseded");
          if (nextPass) {
            await expect(nextPass).resolves.toBe("converged");
          }
          expect(committed).not.toContainEqual({ agentId: "b", everyMs: 3_600_000 });
          const jobs = (await state.cron.list({ includeDisabled: true })).filter((job) =>
            job.declarationKey?.startsWith("heartbeat:"),
          );
          expect(
            jobs.toSorted((a, b) => String(a.agentId).localeCompare(String(b.agentId))),
          ).toMatchObject([
            { agentId: "a", schedule: { everyMs: 7_200_000 } },
            { agentId: "b", schedule: { everyMs: 7_200_000 } },
          ]);
        }
      } finally {
        try {
          await checkpoint;
          await nextPass;
        } finally {
          state.cron.stop();
        }
      }
    },
  );

  it("schedules a retry after a heartbeat inventory failure and cancels it on stop", async () => {
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-monitor-partial-failure");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    try {
      const inventory = vi
        .spyOn(state.cron, "list")
        .mockRejectedValueOnce(new Error("inventory failed"));
      await expect(state.reconcileSystemJobs()).resolves.toBe("retry-scheduled");
      state.cron.stop();
      const callsBeforeStop = inventory.mock.calls.length;
      await clock.advanceBy(30_000);
      expect(inventory).toHaveBeenCalledTimes(callsBeforeStop);
    } finally {
      state.cron.stop();
    }
  });

  it("defers a retiring agent's heartbeat monitor and restores it after deletion rolls back", async () => {
    await withOpenClawTestState({ label: "cron-monitor-retirement" }, async (fixture) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const cfg = {
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          ...heartbeatDefaults("1h"),
          entries: { main: {}, retiring: {} },
        },
      } satisfies OpenClawConfig;
      const scheduler = createTestGatewayScheduler(clock.clock);
      const state = loadCronService(cfg, { scheduler });
      const listJobs = state.cron.list.bind(state.cron);
      let deletion: ReturnType<typeof beginAgentDeletionJournal> | undefined;
      const inventory = vi.spyOn(state.cron, "list").mockImplementationOnce(async (options) => {
        const jobs = await listJobs(options);
        deletion = beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "monitor-retirement",
          agentDir: fixture.agentDir("retiring"),
          workspaceDir: fixture.path("workspace-retiring"),
          sessionsDir: fixture.sessionsDir("retiring"),
          deleteFiles: false,
        });
        return jobs;
      });
      try {
        await expect(state.reconcileSystemJobs()).resolves.toBe("lifecycle-deferred");
        expect((await listJobs({ includeDisabled: true })).map((job) => job.agentId)).toEqual([
          "main",
        ]);
        await expect(
          addAgentTurnJob(state, "retired-owner", "must not run", { agentId: "retiring" }),
        ).rejects.toMatchObject({
          name: "CronAgentDeletionBlockedError",
          message: "cron job agent is unavailable: retiring",
        });

        expect(
          removeAgentDeletionJournal(
            "retiring",
            expectDefined(deletion, "deletion journal").operationId,
          ),
        ).toBe(true);
        await clock.advanceBy(30_000);
        expect(await listJobs({ includeDisabled: true })).toContainEqual(
          expect.objectContaining({
            agentId: "retiring",
            declarationKey: "heartbeat:retiring",
            enabled: true,
            schedule: expect.objectContaining({ everyMs: 3_600_000 }),
          }),
        );
      } finally {
        inventory.mockRestore();
        try {
          await state.cron.stopAndDrain?.();
        } finally {
          await scheduler.stop();
        }
      }
    });
  });
}
