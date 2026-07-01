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
  readJob: ReturnType<typeof vi.fn<CronServiceContract["readJob"]>>;
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
  const schedule =
    input.schedule.kind === "every" && input.schedule.anchorMs === undefined
      ? { ...input.schedule, anchorMs: now }
      : input.schedule;
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
    schedule,
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
      const id = input.id ?? `cron-${seq}`;
      if (jobs.has(id)) {
        throw new Error(`cron job already exists: ${id}`);
      }
      const job = createCronJob(input, id, seq);
      jobs.set(job.id, job);
      return job;
    }),
    update: vi.fn(async (id: string, patch: CronJobPatch) => {
      const current = jobs.get(id);
      if (!current) {
        throw new Error(`missing cron job: ${id}`);
      }
      const nextUpdatedAtMs = current.updatedAtMs + 1;
      const nextState = {
        ...current.state,
        ...patch.state,
      };
      if (typeof patch.enabled === "boolean" && patch.enabled !== current.enabled) {
        if (patch.enabled) {
          nextState.nextRunAtMs ??= 1_700_000_000_000 + nextUpdatedAtMs;
        } else {
          nextState.nextRunAtMs = undefined;
          nextState.runningAtMs = undefined;
        }
      }
      const updated: CronJob = {
        ...current,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        schedule: patch.schedule ?? current.schedule,
        state: nextState,
        updatedAtMs: nextUpdatedAtMs,
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

function readStoredRoutineJson(id = "daily-ops"): Record<string, unknown> | undefined {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT routine_json AS routineJson FROM routine_records WHERE routine_id = ?")
    .get(id) as { routineJson?: string } | undefined;
  return row?.routineJson ? (JSON.parse(row.routineJson) as Record<string, unknown>) : undefined;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
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
        enabled: false,
        agentId: "ops",
        sessionTarget: "isolated",
        deleteAfterRun: false,
        payload: { kind: "agentTurn", message: "Summarize open work" },
      });
      expect(cron.update).toHaveBeenCalledWith(cronJobId, { enabled: true });

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

  it("treats announce delivery with implicit last channel as idempotent", async () => {
    await withOpenClawTestState({ prefix: "routine-delivery-last-idempotent-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput({
        owner: { agentId: "ops", sessionKey: "session-1" },
        target: {
          sessionTarget: "isolated",
          wakeMode: "now",
          delivery: { mode: "announce" },
        },
      });
      await createRoutine(input, { cron });

      const replay = await createRoutine(
        createRoutineInput({
          owner: { agentId: "ops", sessionKey: "session-1" },
          target: {
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "announce", channel: "last" },
          },
        }),
        { cron },
      );

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("defaults keyless routines without delivery to no delivery", async () => {
    await withOpenClawTestState({ prefix: "routine-keyless-none-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          owner: undefined,
          target: {
            sessionTarget: "isolated",
            wakeMode: "now",
          },
        }),
        { cron },
      );

      expect(cron.add.mock.calls[0]?.[0].delivery).toEqual({ mode: "none" });
      expect(created.routine.target.delivery).toEqual({ mode: "none" });
    });
  });

  it("rejects keyless announce delivery without a stable target", async () => {
    await withOpenClawTestState({ prefix: "routine-keyless-announce-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(
          createRoutineInput({
            owner: undefined,
            target: {
              sessionTarget: "isolated",
              wakeMode: "now",
              delivery: { mode: "announce" },
            },
          }),
          { cron },
        ),
      ).rejects.toThrow("routine announce delivery requires owner.sessionKey or delivery.to");
      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("infers the owner agent from agent-scoped session keys", async () => {
    await withOpenClawTestState({ prefix: "routine-session-agent-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          owner: { sessionKey: "AGENT:OPS:MAIN" },
        }),
        { cron },
      );

      expect(cron.add.mock.calls[0]?.[0]).toMatchObject({
        agentId: "ops",
        sessionKey: "agent:ops:main",
      });
      expect(created.routine.owner).toEqual({
        agentId: "ops",
        sessionKey: "agent:ops:main",
      });
      const replay = await createRoutine(
        createRoutineInput({
          owner: { sessionKey: "agent:ops:main" },
        }),
        { cron },
      );
      expect(replay.idempotent).toBe(true);
      expect(cron.add).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects malformed agent-scoped owner session keys", async () => {
    await withOpenClawTestState({ prefix: "routine-session-agent-malformed-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(
          createRoutineInput({
            owner: { sessionKey: "agent::main" },
          }),
          { cron },
        ),
      ).rejects.toThrow("routine owner.sessionKey is malformed");
      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("rejects owner agent ids that conflict with agent-scoped session keys", async () => {
    await withOpenClawTestState({ prefix: "routine-session-agent-conflict-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(
          createRoutineInput({
            owner: { agentId: "main", sessionKey: "agent:ops:main" },
          }),
          { cron },
        ),
      ).rejects.toThrow("routine owner.agentId must match owner.sessionKey agent");
      expect(cron.add).not.toHaveBeenCalled();
    });
  });

  it("infers the owner agent from explicit agent-scoped session targets", async () => {
    await withOpenClawTestState({ prefix: "routine-target-agent-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          owner: undefined,
          target: {
            sessionTarget: "session:AGENT:OPS:MAIN",
            wakeMode: "now",
          },
        }),
        { cron },
      );

      expect(cron.add.mock.calls[0]?.[0]).toMatchObject({
        agentId: "ops",
        sessionTarget: "session:agent:ops:main",
      });
      expect(created.routine.owner).toEqual({ agentId: "ops" });
      expect(created.routine.target.sessionTarget).toBe("session:agent:ops:main");
    });
  });

  it("rejects routine targets that conflict with the owner agent", async () => {
    await withOpenClawTestState({ prefix: "routine-target-agent-conflict-" }, async () => {
      const cron = createFakeCronService();

      await expect(
        createRoutine(
          createRoutineInput({
            owner: { agentId: "main" },
            target: {
              sessionTarget: "session:agent:ops:main",
              wakeMode: "now",
            },
          }),
          { cron },
        ),
      ).rejects.toThrow("routine owner.agentId must match target session agent");
      expect(cron.add).not.toHaveBeenCalled();
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

  it("arms near-now one-shot routines through cron's missed-run grace", async () => {
    await withOpenClawTestState({ prefix: "routine-near-now-at-" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
      const cron = createFakeCronService();
      const at = new Date("2026-01-01T00:00:00Z").toISOString();

      const created = await createRoutine(
        createRoutineInput({
          id: "near-now-routine",
          trigger: { kind: "schedule", schedule: { kind: "at", at } },
        }),
        { cron },
      );

      expect(created.created).toBe(true);
      expect(created.routine.status.status).toBe("enabled");
      expect(cron.add.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
      expect(cron.update).toHaveBeenCalledWith(created.routine.trigger.cronJobId, {
        enabled: true,
      });
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

  it("adopts a matching deterministic backing cron job when the registry row is missing", async () => {
    await withOpenClawTestState({ prefix: "routine-adopt-orphan-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const created = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });
      const cronJobId = created.routine.trigger.cronJobId;
      openOpenClawStateDatabase().db.exec("DELETE FROM routine_records");

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.trigger.cronJobId).toBe(cronJobId);
      expect(cron.add).toHaveBeenCalledTimes(1);
      expect(
        await inspectRoutine("daily-ops", { cron, cronStorePath: "/tmp/cron.sqlite" }),
      ).toMatchObject({
        id: "daily-ops",
        status: { backing: "linked" },
      });
    });
  });

  it("arms an adopted staged backing cron job only after the registry row exists", async () => {
    await withOpenClawTestState({ prefix: "routine-adopt-staged-orphan-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const created = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });
      const cronJobId = created.routine.trigger.cronJobId;
      const cronJob = cron.jobs.get(cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJobId, {
        ...cronJob,
        enabled: false,
        state: { ...cronJob.state, nextRunAtMs: undefined },
      });
      openOpenClawStateDatabase().db.exec("DELETE FROM routine_records");
      cron.update.mockClear();

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.status.status).toBe("enabled");
      expect(cron.update).toHaveBeenCalledWith(cronJobId, { enabled: true });
      await expect(
        inspectRoutine("daily-ops", { cron, cronStorePath: "/tmp/cron.sqlite" }),
      ).resolves.toMatchObject({
        id: "daily-ops",
        enabled: true,
        status: { backing: "linked", enabled: true },
      });
    });
  });

  it("completes a persisted staged routine whose backing cron job was not armed", async () => {
    await withOpenClawTestState({ prefix: "routine-complete-staged-enable-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      cron.update.mockRejectedValueOnce(new Error("interrupted before arm"));

      await expect(
        createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" }),
      ).rejects.toThrow("interrupted before arm");
      const cronJobId = [...cron.jobs.keys()][0];
      if (!cronJobId) {
        throw new Error("expected staged backing cron job");
      }
      cron.update.mockClear();

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.status.status).toBe("enabled");
      expect(cron.update).toHaveBeenCalledWith(cronJobId, { enabled: true });
    });
  });

  it("does not infer staged create from an enabled row with a disabled backing job", async () => {
    await withOpenClawTestState({ prefix: "routine-enabled-row-disabled-cron-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const created = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });
      const cronJobId = created.routine.trigger.cronJobId;
      const cronJob = cron.jobs.get(cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      cron.jobs.set(cronJobId, {
        ...cronJob,
        enabled: false,
        state: { ...cronJob.state, nextRunAtMs: undefined },
      });
      cron.update.mockClear();

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.status.status).toBe("disabled");
      expect(cron.update).not.toHaveBeenCalled();
      await expect(
        inspectRoutine("daily-ops", { cron, cronStorePath: "/tmp/cron.sqlite" }),
      ).resolves.toMatchObject({
        enabled: false,
        status: { enabled: false },
      });
    });
  });

  it("does not re-arm completed one-shot routines with a stale create stage", async () => {
    await withOpenClawTestState({ prefix: "routine-completed-staged-one-shot-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput({
        id: "completed-stage",
        trigger: {
          kind: "schedule",
          schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
        },
      });
      cron.update.mockRejectedValueOnce(new Error("interrupted after staging"));

      await expect(
        createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" }),
      ).rejects.toThrow("interrupted after staging");
      const cronJobId = [...cron.jobs.keys()][0];
      const cronJob = cronJobId ? cron.jobs.get(cronJobId) : undefined;
      if (!cronJobId || !cronJob) {
        throw new Error("expected staged one-shot backing cron job");
      }
      cron.jobs.set(cronJobId, {
        ...cronJob,
        enabled: false,
        state: {
          ...cronJob.state,
          nextRunAtMs: undefined,
          lastRunAtMs: Date.now(),
          lastRunStatus: "ok",
        },
      });
      cron.update.mockClear();

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.status.status).toBe("disabled");
      expect(cron.update).not.toHaveBeenCalled();
      expect(readStoredRoutineJson("completed-stage")).not.toHaveProperty("createStage");
    });
  });

  it("adopts generated-id backing cron jobs when the registry row is missing", async () => {
    await withOpenClawTestState({ prefix: "routine-adopt-generated-orphan-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput({ id: undefined });
      const created = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });
      const routineId = created.routine.id;
      const cronJobId = created.routine.trigger.cronJobId;
      openOpenClawStateDatabase().db.exec("DELETE FROM routine_records");

      const replay = await createRoutine(input, { cron, cronStorePath: "/tmp/cron.sqlite" });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.id).toBe(routineId);
      expect(replay.routine.trigger.cronJobId).toBe(cronJobId);
      expect(cron.add).toHaveBeenCalledTimes(1);
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
      expect(created.routine.trigger.schedule).toEqual({ kind: "every", everyMs: 60_000 });

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.idempotent).toBe(true);
      expect(replay.created).toBe(false);
    });
  });

  it("detects backing cron drift when a generated every anchor changes", async () => {
    await withOpenClawTestState({ prefix: "routine-anchor-drift-" }, async () => {
      const cron = createFakeCronService();
      const input = createRoutineInput();
      const created = await createRoutine(input, { cron });
      const cronJob = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!cronJob || cronJob.schedule.kind !== "every") {
        throw new Error("expected every backing cron job");
      }
      cron.jobs.set(cronJob.id, {
        ...cronJob,
        schedule: { ...cronJob.schedule, anchorMs: cronJob.createdAtMs + 60_000 },
      });

      await expect(createRoutine(input, { cron })).rejects.toThrow("generated anchor");
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
      cron.update.mockClear();

      const disabled = await setRoutineEnabled(` ${created.routine.id} `, false, { cron });
      const disabledAgain = await setRoutineEnabled(` ${created.routine.id} `, false, { cron });

      expect(cron.update).toHaveBeenCalledTimes(1);
      expect(cron.update).toHaveBeenCalledWith(created.routine.trigger.cronJobId, {
        enabled: false,
      });
      expect(disabled.changed).toBe(true);
      expect(disabled.routine.status.status).toBe("disabled");
      expect(disabledAgain.changed).toBe(false);
      expect(disabledAgain.routine.updatedAtMs).toBe(disabled.routine.updatedAtMs);

      const deleted = await deleteRoutine(` ${created.routine.id} `, { cron });
      const deletedAgain = await deleteRoutine(` ${created.routine.id} `, { cron });

      expect(deleted).toEqual({ id: "daily-ops", deleted: true });
      expect(deletedAgain).toEqual({ id: "daily-ops", deleted: false });
      expect(cron.remove).toHaveBeenCalledTimes(1);
      expect(cron.jobs.size).toBe(0);
    });
  });

  it("does not re-arm an explicitly disabled routine on create replay", async () => {
    await withOpenClawTestState({ prefix: "routine-replay-disabled-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      await setRoutineEnabled(created.routine.id, false, { cron });
      cron.update.mockClear();

      const replay = await createRoutine(createRoutineInput(), { cron });

      expect(replay.created).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.routine.status.status).toBe("disabled");
      expect(cron.update).not.toHaveBeenCalled();
    });
  });

  it("persists enable intent before arming a disabled backing cron job", async () => {
    await withOpenClawTestState({ prefix: "routine-enable-stage-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput({ enabled: false }), { cron });
      const cronJobId = created.routine.trigger.cronJobId;
      cron.update.mockRejectedValueOnce(new Error("interrupted before enable"));

      await expect(setRoutineEnabled(created.routine.id, true, { cron })).rejects.toThrow(
        "interrupted before enable",
      );

      expect(readStoredRoutineJson()).toMatchObject({
        enabled: true,
        enableStage: "enabling",
      });
      expect(cron.jobs.get(cronJobId)?.enabled).toBe(false);
      cron.update.mockClear();

      const replay = await setRoutineEnabled(created.routine.id, true, { cron });

      expect(replay.changed).toBe(true);
      expect(replay.routine.status.status).toBe("enabled");
      expect(cron.update).toHaveBeenCalledWith(cronJobId, { enabled: true });
      expect(readStoredRoutineJson()).not.toHaveProperty("enableStage");
    });
  });

  it.each([
    { initialEnabled: false, nextEnabled: true, label: "enable" },
    { initialEnabled: true, nextEnabled: false, label: "disable" },
  ])(
    "rolls back backing cron $label when routine persistence fails",
    async ({ initialEnabled, nextEnabled }) => {
      await withOpenClawTestState(
        { prefix: `routine-toggle-rollback-${initialEnabled ? "on" : "off"}-` },
        async () => {
          const cron = createFakeCronService();
          const created = await createRoutine(
            createRoutineInput({
              id: `toggle-${initialEnabled ? "on" : "off"}`,
              enabled: initialEnabled,
            }),
            { cron },
          );
          const cronJobId = created.routine.trigger.cronJobId;
          const cronJob = cron.jobs.get(cronJobId);
          if (!cronJob) {
            throw new Error("expected backing cron job");
          }
          cron.update.mockClear();
          const previousState = {
            ...cronJob.state,
            lastRunAtMs: 1_700_000_123_000,
            lastRunStatus: "ok" as const,
            lastDurationMs: 42,
          };
          cron.jobs.set(cronJobId, {
            ...cronJob,
            state: previousState,
          });
          openOpenClawStateDatabase().db.exec(`
            CREATE TRIGGER routine_records_force_update_fail
            BEFORE UPDATE ON routine_records
            BEGIN
              SELECT RAISE(FAIL, 'forced routine update failure');
            END;
          `);

          await expect(
            setRoutineEnabled(created.routine.id, nextEnabled, { cron }),
          ).rejects.toThrow(
            nextEnabled
              ? "forced routine update failure"
              : "failed to persist routine: forced routine update failure",
          );

          if (nextEnabled) {
            expect(cron.update).not.toHaveBeenCalled();
            expect(cron.jobs.get(cronJobId)?.enabled).toBe(initialEnabled);
            await expect(inspectRoutine(created.routine.id, { cron })).resolves.toMatchObject({
              enabled: initialEnabled,
            });
            return;
          }

          expect(cron.update).toHaveBeenCalledWith(cronJobId, { enabled: nextEnabled });
          expect(cron.update).toHaveBeenCalledWith(cronJobId, {
            enabled: initialEnabled,
            schedule: cronJob.schedule,
          });
          expect(cron.update).toHaveBeenCalledWith(
            cronJobId,
            expect.objectContaining({
              state: expect.objectContaining(previousState),
            }),
          );
          expect(cron.jobs.get(cronJobId)?.enabled).toBe(initialEnabled);
          expect(cron.jobs.get(cronJobId)?.state).toMatchObject(previousState);
          expect(cron.jobs.get(cronJobId)?.state.nextRunAtMs).toBe(previousState.nextRunAtMs);
          await expect(inspectRoutine(created.routine.id, { cron })).resolves.toMatchObject({
            enabled: initialEnabled,
          });
        },
      );
    },
  );

  it("preserves concurrent cron run state when toggle persistence rollback runs", async () => {
    await withOpenClawTestState({ prefix: "routine-toggle-rollback-interleave-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput({ id: "toggle-interleave" }), {
        cron,
      });
      const cronJobId = created.routine.trigger.cronJobId;
      const cronJob = cron.jobs.get(cronJobId);
      if (!cronJob) {
        throw new Error("expected backing cron job");
      }
      const concurrentState = {
        ...cronJob.state,
        nextRunAtMs: 1_700_000_999_000,
        runningAtMs: undefined,
        lastRunAtMs: 1_700_000_998_000,
        lastRunStatus: "error" as const,
        lastError: "run failed after toggle",
      };
      let readCount = 0;
      cron.readJob.mockImplementation(async (id: string) => {
        const current = cron.jobs.get(id);
        if (id === cronJobId) {
          readCount += 1;
          if (readCount === 3 && current) {
            const concurrent = {
              ...current,
              state: concurrentState,
              updatedAtMs: current.updatedAtMs + 1,
            };
            cron.jobs.set(id, concurrent);
            return concurrent;
          }
        }
        return current;
      });
      openOpenClawStateDatabase().db.exec(`
        CREATE TRIGGER routine_records_force_update_fail
        BEFORE UPDATE ON routine_records
        BEGIN
          SELECT RAISE(FAIL, 'forced routine update failure');
        END;
      `);

      await expect(setRoutineEnabled(created.routine.id, false, { cron })).rejects.toThrow(
        "failed to persist routine: forced routine update failure",
      );

      expect(cron.jobs.get(cronJobId)?.enabled).toBe(true);
      expect(cron.jobs.get(cronJobId)?.state).toMatchObject(concurrentState);
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
      const disabledAgain = await setRoutineEnabled(created.routine.id, false, { cron });

      expect(listed.routines[0]?.status).toMatchObject({
        status: "missing",
        backing: "missing",
        cronJobId: created.routine.trigger.cronJobId,
      });
      expect(disabled.routine.status.status).toBe("missing");
      expect(disabledAgain.changed).toBe(false);
      expect(disabledAgain.routine.updatedAtMs).toBe(disabled.routine.updatedAtMs);
      await expect(setRoutineEnabled(created.routine.id, true, { cron })).rejects.toThrow(
        "backing cron job is missing",
      );
    });
  });

  it("reports missing status when backing cron disappears after a toggle update", async () => {
    await withOpenClawTestState({ prefix: "routine-toggle-missing-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(createRoutineInput(), { cron });
      const updateImpl = cron.update.getMockImplementation();
      if (!updateImpl) {
        throw new Error("expected cron update implementation");
      }
      cron.update.mockImplementationOnce(async (id, patch) => {
        const updated = await updateImpl(id, patch);
        cron.jobs.delete(id);
        return updated;
      });

      const disabled = await setRoutineEnabled(created.routine.id, false, { cron });

      expect(disabled.changed).toBe(true);
      expect(disabled.routine.status).toMatchObject({
        status: "missing",
        backing: "missing",
        cronJobId: created.routine.trigger.cronJobId,
      });
    });
  });

  it("rejects re-enabling expired one-shot routines", async () => {
    await withOpenClawTestState({ prefix: "routine-expired-enable-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          id: "expired-one-shot",
          enabled: false,
          trigger: {
            kind: "schedule",
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          },
        }),
        { cron },
      );
      const job = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!job) {
        throw new Error("expected backing cron job");
      }
      cron.update.mockClear();
      cron.jobs.set(job.id, {
        ...job,
        enabled: false,
        schedule: { kind: "at", at: new Date(Date.now() - 30_000).toISOString() },
        state: { ...job.state, nextRunAtMs: undefined },
      });

      await expect(setRoutineEnabled(created.routine.id, true, { cron })).rejects.toThrow(
        "cannot enable expired one-shot routine",
      );

      expect(cron.update).not.toHaveBeenCalled();
    });
  });

  it("keeps already-enabled expired one-shot enable idempotent", async () => {
    await withOpenClawTestState({ prefix: "routine-expired-enable-idempotent-" }, async () => {
      const cron = createFakeCronService();
      const created = await createRoutine(
        createRoutineInput({
          id: "running-one-shot",
          trigger: {
            kind: "schedule",
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          },
        }),
        { cron },
      );
      const job = cron.jobs.get(created.routine.trigger.cronJobId);
      if (!job) {
        throw new Error("expected backing cron job");
      }
      cron.update.mockClear();
      cron.jobs.set(job.id, {
        ...job,
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() - 30_000).toISOString() },
      });

      await expect(setRoutineEnabled(created.routine.id, true, { cron })).resolves.toMatchObject({
        changed: false,
      });

      expect(cron.update).not.toHaveBeenCalled();
    });
  });
});
