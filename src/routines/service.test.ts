import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createRoutine,
  deleteRoutine,
  inspectRoutine,
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

function createRoutineCronJobIdForTest(routineId: string): string {
  const digest = crypto.createHash("sha256").update(routineId).digest("hex").slice(0, 32);
  return `routine-cron-${digest}`;
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

      const context = { cron, cronStorePath: "/tmp/cron.sqlite" };
      const listed = await listRoutines({ includeDisabled: true }, context);
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
      expect(await listRoutines({ agentId: "Ops" }, context)).toMatchObject({
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

  it("validates cron delivery only before creating a new backing job", async () => {
    await withOpenClawTestState({ prefix: "routine-delivery-validate-replay-" }, async () => {
      const cron = createFakeCronService();
      const validateCronCreate = vi.fn(async () => undefined);
      await createRoutine(createRoutineInput(), { cron, validateCronCreate });
      validateCronCreate.mockRejectedValueOnce(new Error("delivery unavailable"));

      const replay = await createRoutine(createRoutineInput(), { cron, validateCronCreate });

      expect(replay.idempotent).toBe(true);
      expect(validateCronCreate).toHaveBeenCalledTimes(1);
      expect(cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects blank explicit routine ids instead of generating a new id", async () => {
    await withOpenClawTestState({ prefix: "routine-blank-id-" }, async () => {
      const cron = createFakeCronService();

      await expect(createRoutine(createRoutineInput({ id: "   " }), { cron })).rejects.toThrow(
        "routine id must not be blank",
      );

      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("rejects payloads that normalize to empty text before creating cron jobs", async () => {
    await withOpenClawTestState({ prefix: "routine-blank-action-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(createRoutineInput({ action: { kind: "agentTurn", message: "   " } }), {
          cron,
        }),
      ).rejects.toThrow("routine agent message must not be blank");
      await expect(
        createRoutine(
          createRoutineInput({
            id: "blank-event",
            target: { sessionTarget: "main", wakeMode: "now" },
            action: { kind: "systemEvent", text: "\n\t" },
          }),
          { cron },
        ),
      ).rejects.toThrow("routine system event text must not be blank");

      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("rejects new one-shot routines scheduled too far in the past", async () => {
    await withOpenClawTestState({ prefix: "routine-past-at-" }, async () => {
      const cron = createFakeCronService();
      const pastAt = new Date(Date.now() - 120_000).toISOString();

      await expect(
        createRoutine(
          createRoutineInput({
            id: "past-routine",
            trigger: { kind: "schedule", schedule: { kind: "at", at: pastAt } },
          }),
          { cron },
        ),
      ).rejects.toThrow("schedule.at is in the past");

      expect(cron.add).not.toHaveBeenCalled();
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

  it("does not persist a routine when cron rejects before creating a durable job", async () => {
    await withOpenClawTestState({ prefix: "routine-pending-retry-" }, async () => {
      const cron = createFakeCronService();
      cron.add.mockRejectedValueOnce(new Error("transient cron write failure"));

      await expect(createRoutine(createRoutineInput(), { cron })).rejects.toThrow(
        "transient cron write failure",
      );

      await expect(listRoutines({ includeDisabled: true }, { cron })).resolves.toEqual({
        routines: [],
      });

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.created).toBe(true);
      expect(replay.idempotent).toBe(false);
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

  it("links an orphaned deterministic cron job after an interrupted create", async () => {
    await withOpenClawTestState({ prefix: "routine-orphan-cron-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const cronJobId = createRoutineCronJobIdForTest(input.id ?? "daily-ops");
      cron.jobs.set(
        cronJobId,
        createCronJob(
          {
            id: cronJobId,
            name: "Daily ops",
            enabled: true,
            deleteAfterRun: false,
            agentId: "ops",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Summarize open work" },
            delivery: { mode: "announce" },
          },
          cronJobId,
          1,
        ),
      );

      const created = await createRoutine(input, { cron });

      expect(created.created).toBe(true);
      expect(created.routine.status.backing).toBe("linked");
      expect(created.routine.trigger.cronJobId).toBe(cronJobId);
      expect(cron.add).not.toHaveBeenCalled();
      await expect(inspectRoutine(created.routine.id, { cron })).resolves.toMatchObject({
        status: { backing: "linked" },
      });
    });
  });

  it("rejects deterministic orphan cron jobs with different intent", async () => {
    await withOpenClawTestState({ prefix: "routine-orphan-drift-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const cronJobId = createRoutineCronJobIdForTest(input.id ?? "daily-ops");
      cron.jobs.set(
        cronJobId,
        createCronJob(
          {
            id: cronJobId,
            name: "Daily ops",
            enabled: true,
            deleteAfterRun: false,
            agentId: "ops",
            schedule: { kind: "every", everyMs: 120_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Summarize open work" },
            delivery: { mode: "announce" },
          },
          cronJobId,
          1,
        ),
      );

      await expect(createRoutine(input, { cron })).rejects.toThrow("different intent");
      expect(cron.add).not.toHaveBeenCalled();
      await expect(inspectRoutine(input.id ?? "daily-ops", { cron })).resolves.toBeUndefined();
    });
  });

  it("recovers a matching orphan cron job without current delivery validation", async () => {
    await withOpenClawTestState({ prefix: "routine-orphan-delivery-replay-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const cronJobId = createRoutineCronJobIdForTest(input.id ?? "daily-ops");
      cron.jobs.set(
        cronJobId,
        createCronJob(
          {
            id: cronJobId,
            name: "Daily ops",
            enabled: true,
            deleteAfterRun: false,
            agentId: "ops",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Summarize open work" },
            delivery: { mode: "announce" },
          },
          cronJobId,
          1,
        ),
      );
      const validateCronCreate = vi.fn(async () => {
        throw new Error("delivery unavailable");
      });

      const created = await createRoutine(input, { cron, validateCronCreate });

      expect(created.routine.status.backing).toBe("linked");
      expect(validateCronCreate).not.toHaveBeenCalled();
      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("rolls back a newly added cron job when routine persistence fails", async () => {
    await withOpenClawTestState({ prefix: "routine-persist-rollback-" }, async () => {
      const cron = createFakeCronService();
      let cronJobId = "";
      cron.add.mockImplementationOnce(async (input: CronJobCreate) => {
        const job = createCronJob(input, input.id ?? "created-job", 1);
        cronJobId = job.id;
        cron.jobs.set(job.id, job);
        openOpenClawStateDatabase().db.exec(`
          CREATE TRIGGER routine_records_force_fail
          BEFORE INSERT ON routine_records
          BEGIN
            SELECT RAISE(FAIL, 'forced routine persist failure');
          END;
        `);
        return job;
      });

      await expect(createRoutine(createRoutineInput({ id: undefined }), { cron })).rejects.toThrow(
        "failed to persist routine: forced routine persist failure",
      );

      expect(cron.remove).toHaveBeenCalledWith(cronJobId);
      expect(cron.jobs.has(cronJobId)).toBe(false);
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

  it("rejects idempotent replay when the backing cron job became delete-after-run", async () => {
    await withOpenClawTestState({ prefix: "routine-delete-after-run-drift-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput({
        id: "one-shot-routine",
        trigger: {
          kind: "schedule",
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        },
      });
      const created = await createRoutine(input, { cron });
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJob.id, { ...cronJob, deleteAfterRun: true });

      await expect(createRoutine(input, { cron })).rejects.toThrow("deleteAfterRun");
    });
  });

  it("detects backing cron drift before treating create as idempotent", async () => {
    await withOpenClawTestState({ prefix: "routine-cron-drift-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJob.id, {
        ...cronJob,
        schedule: { kind: "every", everyMs: 120_000 },
        updatedAtMs: cronJob.updatedAtMs + 1,
      });

      const listed = await listRoutines({ includeDisabled: true }, { cron });
      expect(listed.routines[0]?.trigger.schedule).toEqual({
        kind: "every",
        everyMs: 120_000,
      });
      await expect(createRoutine(createRoutineInput(), { cron })).rejects.toThrow(
        "different intent",
      );
    });
  });

  it("ignores scheduler-generated every anchors when replaying create", async () => {
    await withOpenClawTestState({ prefix: "routine-anchor-replay-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob || cronJob.schedule.kind !== "every") {
        throw new Error("expected every backing cron job");
      }
      cron.jobs.set(cronJob.id, {
        ...cronJob,
        schedule: { ...cronJob.schedule, anchorMs: 1_700_000_000_000 },
      });

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.idempotent).toBe(true);
      expect(replay.created).toBe(false);
    });
  });

  it("preserves explicit every anchors as routine intent", async () => {
    await withOpenClawTestState({ prefix: "routine-explicit-anchor-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput({
        id: "anchored-routine",
        trigger: {
          kind: "schedule",
          schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_700_000_000_000 },
        },
      });
      await createRoutine(input, { cron });

      await expect(
        createRoutine(
          createRoutineInput({
            id: "anchored-routine",
            trigger: {
              kind: "schedule",
              schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_700_000_060_000 },
            },
          }),
          { cron },
        ),
      ).rejects.toThrow("different intent");
    });
  });

  it("returns missing status without recreating a missing backing job", async () => {
    await withOpenClawTestState({ prefix: "routine-missing-disabled-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput({ enabled: false }), { cron });
      cron.jobs.delete(created.routine.trigger.cronJobId);

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.idempotent).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.routine.enabled).toBe(false);
      expect(replay.routine.status).toMatchObject({
        status: "missing",
        backing: "missing",
        cronJobId: created.routine.trigger.cronJobId,
      });
      expect(cron.add).toHaveBeenCalledTimes(1);
      expect(cron.jobs.has(created.routine.trigger.cronJobId)).toBe(false);
    });
  });

  it("filters routine lists against canonical cron fields", async () => {
    await withOpenClawTestState({ prefix: "routine-live-filter-canonical-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          id: "default-owner",
          name: "Original name",
          owner: undefined,
        }),
        { cron },
      );
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJob.id, {
        ...cronJob,
        name: "Renamed live routine",
        updatedAtMs: cronJob.updatedAtMs + 1,
      });

      await expect(listRoutines({ agentId: "default-agent" }, { cron })).resolves.toMatchObject({
        routines: [{ id: "default-owner" }],
      });
      await expect(listRoutines({ query: "renamed live" }, { cron })).resolves.toMatchObject({
        routines: [{ id: "default-owner", name: "Renamed live routine" }],
      });
    });
  });

  it("scopes routine ids to the active cron store", async () => {
    await withOpenClawTestState({ prefix: "routine-store-scope-" }, async () => {
      const cronA = createFakeCronService();
      const cronB = createFakeCronService();
      const storeA = "/tmp/routine-store-a.sqlite";
      const storeB = "/tmp/routine-store-b.sqlite";

      await createRoutine(
        createRoutineInput({
          id: "store-routine",
          name: "Store A routine",
          action: { kind: "agentTurn", message: "Summarize store A." },
        }),
        { cron: cronA, cronStorePath: storeA },
      );
      await createRoutine(
        createRoutineInput({
          id: "store-routine",
          name: "Store B routine",
          action: { kind: "agentTurn", message: "Summarize store B." },
        }),
        { cron: cronB, cronStorePath: storeB },
      );

      const listedA = await listRoutines(
        { includeDisabled: true },
        { cron: cronA, cronStorePath: storeA },
      );
      const listedB = await listRoutines(
        { includeDisabled: true },
        { cron: cronB, cronStorePath: storeB },
      );

      expect(listedA.routines).toMatchObject([{ id: "store-routine", name: "Store A routine" }]);
      expect(listedB.routines).toMatchObject([{ id: "store-routine", name: "Store B routine" }]);

      await deleteRoutine("store-routine", { cron: cronB, cronStorePath: storeB });

      await expect(
        inspectRoutine("store-routine", { cron: cronA, cronStorePath: storeA }),
      ).resolves.toMatchObject({
        id: "store-routine",
        name: "Store A routine",
      });
      await expect(
        inspectRoutine("store-routine", { cron: cronB, cronStorePath: storeB }),
      ).resolves.toBeUndefined();
    });
  });

  it("surfaces delivery outcome on routine status", async () => {
    await withOpenClawTestState({ prefix: "routine-delivery-status-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJob.id, {
        ...cronJob,
        state: {
          ...cronJob.state,
          lastRunAtMs: 1_700_000_000_000,
          lastRunStatus: "ok",
          lastDelivered: false,
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "Message failed",
        },
      });

      await expect(inspectRoutine(created.routine.id, { cron })).resolves.toMatchObject({
        status: {
          lastRunStatus: "ok",
          lastDelivered: false,
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "Message failed",
        },
      });
    });
  });

  it("rejects main-session webhook routines before creating cron jobs", async () => {
    await withOpenClawTestState({ prefix: "routine-main-webhook-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(
          createRoutineInput({
            id: "main-webhook",
            target: {
              sessionTarget: "main",
              wakeMode: "now",
              delivery: { mode: "webhook", to: "https://example.invalid/hook" },
            },
            action: { kind: "systemEvent", text: "check status" },
          }),
          { cron },
        ),
      ).rejects.toThrow("main-session routines do not support webhook delivery");
      expect(cron.add).not.toHaveBeenCalled();
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
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
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

      const disabled = await setRoutineEnabled(` ${created.routine.id} `, false, { cron });
      const disabledAgain = await setRoutineEnabled(` ${created.routine.id} `, false, { cron });

      expect(cron.update).toHaveBeenCalledTimes(1);
      expect(cron.update).toHaveBeenCalledWith(created.routine.trigger.cronJobId, {
        enabled: false,
      });
      expect(disabled.changed).toBe(true);
      expect(disabled.routine.status.status).toBe("disabled");
      expect(disabledAgain.changed).toBe(false);

      const deleted = await deleteRoutine(` ${created.routine.id} `, { cron });
      const deletedAgain = await deleteRoutine(` ${created.routine.id} `, { cron });

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
