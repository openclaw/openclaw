import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  setRoutineEnabled,
  type RoutineCreateInput,
} from "./service.js";

type FakeCronService = CronServiceContract & {
  jobs: Map<string, CronJob>;
  add: ReturnType<typeof vi.fn<CronServiceContract["add"]>>;
  update: ReturnType<typeof vi.fn<CronServiceContract["update"]>>;
  remove: ReturnType<typeof vi.fn<CronServiceContract["remove"]>>;
};

function createRoutineInput(overrides: Partial<RoutineCreateInput> = {}): RoutineCreateInput {
  return {
    id: "daily-ops",
    name: "Daily ops",
    owner: { agentId: "ops" },
    trigger: {
      kind: "schedule",
      schedule: { kind: "every", everyMs: 60_000 },
    },
    target: {
      sessionTarget: "isolated",
      wakeMode: "now",
    },
    action: {
      kind: "agentTurn",
      message: "Summarize open work",
    },
    ...overrides,
  };
}

function createCronJob(input: CronJobCreate, id: string, now: number): CronJob {
  return {
    ...input,
    id,
    enabled: input.enabled ?? true,
    createdAtMs: now,
    updatedAtMs: now,
    state: {
      ...input.state,
      nextRunAtMs: 1_700_000_000_000 + now,
    },
  };
}

function createFakeCronService(): FakeCronService {
  let seq = 0;
  const jobs = new Map<string, CronJob>();
  const service = {
    jobs,
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    status: vi.fn(async () => ({
      enabled: true,
      storePath: "/tmp/cron.sqlite",
      storage: "sqlite" as const,
      sqlitePath: "/tmp/openclaw-state.sqlite",
      jobs: jobs.size,
      nextWakeAtMs: null,
    })),
    list: vi.fn(async (opts?: { includeDisabled?: boolean }) =>
      [...jobs.values()].filter((job) => opts?.includeDisabled || job.enabled),
    ),
    listPage: vi.fn(async () => ({
      jobs: [...jobs.values()],
      total: jobs.size,
      offset: 0,
      limit: jobs.size,
      hasMore: false,
      nextOffset: null,
    })),
    add: vi.fn(async (input: CronJobCreate) => {
      seq += 1;
      const job = createCronJob(input, input.id ?? `cron-${seq}`, seq);
      jobs.set(job.id, job);
      return job;
    }),
    update: vi.fn(async (id: string, patch: CronJobPatch) => {
      const current = jobs.get(id);
      if (!current) {
        throw new Error(`missing cron job: ${id}`);
      }
      const updated: CronJob = {
        ...current,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        state: {
          ...current.state,
          ...patch.state,
        },
        updatedAtMs: current.updatedAtMs + 1,
      };
      jobs.set(id, updated);
      return updated;
    }),
    remove: vi.fn(async (id: string) => {
      const removed = jobs.delete(id);
      return { ok: true as const, removed };
    }),
    run: vi.fn(async () => ({ ok: true as const, ran: true as const })),
    enqueueRun: vi.fn(async () => ({ ok: true as const, ran: true as const })),
    getJob: vi.fn((id: string) => jobs.get(id)),
    readJob: vi.fn(async (id: string) => jobs.get(id)),
    getDefaultAgentId: vi.fn(() => "default-agent"),
    wake: vi.fn(() => ({ ok: true as const })),
  } satisfies FakeCronService;
  return service;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("routine service", () => {
  it("creates a durable schedule routine through cron and lists live status", async () => {
    await withOpenClawTestState({ prefix: "routine-service-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), {
        cron,
        cronStorePath: "/tmp/cron.sqlite",
      });

      expect(created.created).toBe(true);
      expect(created.idempotent).toBe(false);
      const cronJobId = created.routine.trigger.cronJobId;
      expect(cronJobId).toMatch(/^routine-cron-/);
      expect(cron.add).toHaveBeenCalledTimes(1);
      expect(cron.add.mock.calls[0]?.[0]).toMatchObject({
        id: cronJobId,
        name: "Daily ops",
        agentId: "ops",
        sessionTarget: "isolated",
        deleteAfterRun: false,
        payload: { kind: "agentTurn", message: "Summarize open work" },
      });

      const listed = await listRoutines({ includeDisabled: true }, { cron });
      expect(listed.routines).toHaveLength(1);
      expect(listed.routines[0]).toMatchObject({
        id: "daily-ops",
        status: {
          status: "enabled",
          backing: "linked",
          cronJobId,
          nextRunAtMs: 1_700_000_000_001,
        },
      });
      expect(await listRoutines({ agentId: "Ops" }, { cron })).toMatchObject({
        routines: [{ id: "daily-ops" }],
      });
    });
  });

  it("treats repeated create with the same id and intent as idempotent", async () => {
    await withOpenClawTestState({ prefix: "routine-idempotent-" }, async () => {
      const cron = createFakeCronService();
      await createRoutine(createRoutineInput(), { cron });

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.trigger.cronJobId).toMatch(/^routine-cron-/);
      expect(cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("serializes concurrent creates with the same id", async () => {
    await withOpenClawTestState({ prefix: "routine-concurrent-" }, async () => {
      const cron = createFakeCronService();

      const [first, second] = await Promise.all([
        createRoutine(createRoutineInput(), { cron }),
        createRoutine(createRoutineInput(), { cron }),
      ]);

      expect(cron.add).toHaveBeenCalledTimes(1);
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      expect(first.routine.trigger.cronJobId).toBe(second.routine.trigger.cronJobId);
    });
  });

  it("retries a pending routine create with the reserved cron id", async () => {
    await withOpenClawTestState({ prefix: "routine-pending-retry-" }, async () => {
      const cron = createFakeCronService();
      cron.add.mockRejectedValueOnce(new Error("transient cron write failure"));

      await expect(createRoutine(createRoutineInput(), { cron })).rejects.toThrow(
        "transient cron write failure",
      );

      const pending = await listRoutines({ includeDisabled: true }, { cron });
      expect(pending.routines[0]?.status.status).toBe("missing");

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(cron.add).toHaveBeenCalledTimes(2);
      expect(cron.jobs.size).toBe(1);
      expect(replay.routine.trigger.cronJobId).toMatch(/^routine-cron-/);
    });
  });

  it("links a backing cron job when creation commits but the response is lost", async () => {
    await withOpenClawTestState({ prefix: "routine-lost-cron-response-" }, async () => {
      const cron = createFakeCronService();
      cron.add.mockImplementationOnce(async (input: CronJobCreate) => {
        const job = createCronJob(input, input.id ?? "lost-response", 1);
        cron.jobs.set(job.id, job);
        throw new Error("lost cron response");
      });

      const created = await createRoutine(createRoutineInput(), { cron });

      expect(created.created).toBe(true);
      expect(created.routine.status.backing).toBe("linked");
      expect(cron.jobs.size).toBe(1);
    });
  });

  it("rejects a repeated create id with different intent", async () => {
    await withOpenClawTestState({ prefix: "routine-conflict-" }, async () => {
      const cron = createFakeCronService();
      await createRoutine(createRoutineInput(), { cron });

      await expect(
        createRoutine(
          createRoutineInput({
            name: "Different ops",
          }),
          { cron },
        ),
      ).rejects.toThrow("different intent");
      expect(cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps one-shot routines durable and resolves current session targets", async () => {
    await withOpenClawTestState({ prefix: "routine-current-" }, async () => {
      const cron = createFakeCronService();
      await createRoutine(
        createRoutineInput({
          id: "current-session",
          owner: { agentId: "ops", sessionKey: "agent:ops:main" },
          trigger: {
            kind: "schedule",
            schedule: { kind: "at", at: new Date(1_700_000_000_000).toISOString() },
          },
          target: {
            sessionTarget: "current",
            wakeMode: "now",
          },
        }),
        { cron },
      );

      expect(cron.add.mock.calls[0]?.[0]).toMatchObject({
        deleteAfterRun: false,
        sessionTarget: "session:agent:ops:main",
      });
    });
  });

  it("disables and deletes the backing cron job idempotently", async () => {
    await withOpenClawTestState({ prefix: "routine-delete-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });

      const disabled = await setRoutineEnabled(created.routine.id, false, { cron });
      const disabledAgain = await setRoutineEnabled(created.routine.id, false, { cron });

      expect(cron.update).toHaveBeenCalledTimes(1);
      expect(cron.update).toHaveBeenCalledWith(created.routine.trigger.cronJobId, {
        enabled: false,
      });
      expect(disabled.changed).toBe(true);
      expect(disabled.routine.status.status).toBe("disabled");
      expect(disabledAgain.changed).toBe(false);

      const deleted = await deleteRoutine(created.routine.id, { cron });
      const deletedAgain = await deleteRoutine(created.routine.id, { cron });

      expect(deleted).toEqual({ id: "daily-ops", deleted: true });
      expect(deletedAgain).toEqual({ id: "daily-ops", deleted: false });
      expect(cron.remove).toHaveBeenCalledTimes(1);
      expect(cron.jobs.size).toBe(0);
    });
  });

  it("preserves the routine record when backing cron removal fails", async () => {
    await withOpenClawTestState({ prefix: "routine-delete-failure-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      cron.remove.mockRejectedValueOnce(new Error("cron persist failed"));

      await expect(deleteRoutine(created.routine.id, { cron })).rejects.toThrow(
        "cron persist failed",
      );

      expect(await listRoutines({ includeDisabled: true }, { cron })).toMatchObject({
        routines: [{ id: "daily-ops", status: { backing: "linked" } }],
      });
    });
  });

  it("filters routine lists on live cron enabled state and paginates after joining", async () => {
    await withOpenClawTestState({ prefix: "routine-live-filter-" }, async () => {
      const cron = createFakeCronService();
      const first = await createRoutine(createRoutineInput({ id: "first-routine" }), { cron });
      await createRoutine(createRoutineInput({ id: "second-routine" }), { cron });
      const firstJob = cron.jobs.get(first.routine.trigger.cronJobId);
      if (!firstJob) {
        throw new Error("expected first cron job");
      }
      cron.jobs.set(firstJob.id, { ...firstJob, enabled: false });

      expect((await listRoutines({}, { cron })).routines.map((routine) => routine.id)).toEqual([
        "second-routine",
      ]);
      expect(
        (await listRoutines({ includeDisabled: true, offset: 1 }, { cron })).routines,
      ).toHaveLength(1);
    });
  });

  it("surfaces missing backing cron state instead of hiding the routine", async () => {
    await withOpenClawTestState({ prefix: "routine-missing-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      cron.jobs.clear();

      const listed = await listRoutines({ includeDisabled: true }, { cron });
      const disabled = await setRoutineEnabled(created.routine.id, false, { cron });

      expect(listed.routines[0]?.status).toMatchObject({
        status: "missing",
        backing: "missing",
        cronJobId: created.routine.trigger.cronJobId,
      });
      expect(disabled.routine.status.status).toBe("missing");
      await expect(setRoutineEnabled(created.routine.id, true, { cron })).rejects.toThrow(
        "backing cron job is missing",
      );
    });
  });
});
