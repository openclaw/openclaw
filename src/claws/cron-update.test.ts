import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawCronUpdate, ClawCronAddRejectedError } from "./cron-update.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  readClawCronRefs,
  upsertClawCronRef,
  type PersistedClawCronRef,
} from "./cron.js";
import { createClawUpdatePlanFixture as plan } from "./resource-update.test-helpers.js";
import type { ClawCronJob, ClawManifest } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

const oldDaily: ClawCronJob = {
  id: "daily",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  session: "main",
  message: "Old daily",
};
const newDaily: ClawCronJob = { ...oldDaily, message: "New daily" };
const legacy: ClawCronJob = {
  id: "legacy",
  schedule: { cron: "0 8 * * *", timezone: "UTC" },
  session: "isolated",
  message: "Legacy",
};
const weekly: ClawCronJob = {
  id: "weekly",
  schedule: { cron: "0 9 * * 1", timezone: "UTC" },
  session: "main",
  message: "Weekly",
};

function ref(job: ClawCronJob, schedulerJobId: string): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: "worker",
    manifestId: job.id,
    declarationKey: `claw:worker:${job.id}`,
    schedulerJobId,
    status: "complete",
    job,
    createdAtMs: 10,
    updatedAtMs: 10,
  };
}

function cronReadView(agentId: string, value: PersistedClawCronRef) {
  const normalized = normalizeCronJobCreate(clawCronGatewayInput(agentId, value));
  if (!normalized || !value.schedulerJobId) {
    throw new Error("expected complete cron provenance");
  }
  return cronJobReadView({
    ...normalized,
    id: value.schedulerJobId,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: { nextRunAtMs: 100, lastRunAtMs: 50, lastStatus: "ok" },
  });
}

function manifest(): ClawManifest {
  return {
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [],
    mcpServers: {},
    cronJobs: [newDaily, weekly],
  };
}

describe("applyClawCronUpdate", () => {
  it.each([
    { action: "change" as const, job: oldDaily },
    { action: "remove" as const, job: legacy },
  ])(
    "refuses to $action unsupported cron provenance before scheduler access",
    async ({ action, job }) => {
      const schedulerJobId = `scheduler-${job.id}`;
      const previous = {
        ...ref(job, schedulerJobId),
        schemaVersion: "openclaw.clawCronRef.v2",
      };
      const get = vi.fn(async () => cronReadView("worker", previous));
      const add = vi.fn(async () => ({ id: previous.schedulerJobId }));
      const remove = vi.fn(async () => ({ removed: true }));
      const upsertRef = vi.fn(async () => undefined);

      await expect(
        applyClawCronUpdate(
          plan([
            {
              kind: "cronJob",
              id: job.id,
              action,
              target: schedulerJobId,
              blocked: false,
              reason: "reviewed earlier",
            },
          ]),
          manifest(),
          {
            readRefs: async () => [previous],
            upsertRef,
            cronGateway: { get, add, remove },
          },
        ),
      ).rejects.toMatchObject({ partial: false, message: expect.stringContaining("unsupported") });
      expect(get).not.toHaveBeenCalled();
      expect(upsertRef).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("checks reviewed access at the pending cron-ref write", async () => {
    let accessCurrent = true;
    let persisted = false;
    const add = vi.fn(async () => ({ id: "scheduler-daily" }));

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "add",
            target: "claw:worker:daily",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          readRefs: async () => [],
          upsertRef: async (
            _record: PersistedClawCronRef,
            writeOptions?: { assertCurrent?: () => void },
          ) => {
            accessCurrent = false;
            writeOptions?.assertCurrent?.();
            persisted = true;
          },
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
          cronGateway: { add, remove: vi.fn(), get: vi.fn() },
        },
      ),
    ).rejects.toMatchObject({ message: "reviewed access changed", partial: false });

    expect(persisted).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("checks reviewed access at the scheduler's async add commit", async () => {
    let accessCurrent = true;
    let committed = false;
    const add = vi.fn(
      async (_input: Record<string, unknown>, options?: { commitGuard?: () => void }) => {
        accessCurrent = false;
        options?.commitGuard?.();
        committed = true;
        return { id: "scheduler-daily" };
      },
    );

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "add",
            target: "claw:worker:daily",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          readRefs: async () => [],
          upsertRef: vi.fn(async () => undefined),
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
          cronGateway: { add, remove: vi.fn(), get: vi.fn() },
        },
      ),
    ).rejects.toMatchObject({ message: "reviewed access changed", partial: true });

    expect(committed).toBe(false);
  });

  it("checks reviewed access at the scheduler's async remove commit", async () => {
    let accessCurrent = true;
    let removed = false;
    const previous = ref(legacy, "scheduler-legacy");
    const remove = vi.fn(async (_id: string, options?: { commitGuard?: () => void }) => {
      accessCurrent = false;
      options?.commitGuard?.();
      removed = true;
      return { removed: true };
    });

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "legacy",
            action: "remove",
            target: "scheduler-legacy",
            blocked: false,
            reason: "removed",
          },
        ]),
        manifest(),
        {
          readRefs: async () => [previous],
          upsertRef: vi.fn(async () => undefined),
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
          cronGateway: {
            add: vi.fn(),
            remove,
            get: async () => cronReadView("worker", previous),
          },
        },
      ),
    ).rejects.toMatchObject({ message: "reviewed access changed", partial: true });

    expect(removed).toBe(false);
  });

  it("keeps rollback authorized when reviewed access changes between forward jobs", async () => {
    let accessCurrent = true;
    const add = vi.fn(async () => ({ id: "scheduler-daily" }));
    const remove = vi.fn(async (_id: string, options?: { commitGuard?: () => void }) => {
      options?.commitGuard?.();
      return { removed: true };
    });
    const deleteRef = vi.fn(async () => undefined);

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "add",
            target: "claw:worker:daily",
            blocked: false,
            reason: "added",
          },
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          readRefs: async () => [],
          upsertRef: async (record: PersistedClawCronRef) => {
            if (record.manifestId === "daily" && record.status === "complete") {
              accessCurrent = false;
            }
          },
          deleteRef,
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
          assertCurrent: vi.fn(),
          cronGateway: {
            add,
            remove,
            get: vi.fn(async () => cronReadView("worker", ref(newDaily, "scheduler-daily"))),
          },
        },
      ),
    ).rejects.toMatchObject({ message: "reviewed access changed", partial: false });

    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledExactlyOnceWith("scheduler-daily", {
      commitGuard: expect.any(Function),
      expectedConfigRevision: cronReadView("worker", ref(newDaily, "scheduler-daily"))
        .configRevision,
    });
    expect(deleteRef).toHaveBeenCalledExactlyOnceWith("worker", "daily", expect.any(Object));
  });

  it.each(["add", "change"] as const)(
    "preserves ownership before a failed readiness wait and permits %s retry",
    async (action) => {
      const env = { OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-readiness-"), "state") };
      const previous = ref(oldDaily, "scheduler-daily");
      if (action === "change") {
        upsertClawCronRef(previous, { env });
      }
      readClawCronRefs("worker", { env });
      const database = openOpenClawStateDatabase({ env });
      const rows = () =>
        JSON.stringify(
          database.db.prepare("SELECT * FROM claw_cron_refs ORDER BY agent_id, manifest_id").all(),
        );
      const before = rows();
      const order: string[] = [];
      const waitUntilAgentAvailable = vi.fn(async () => {
        order.push("wait");
      });
      waitUntilAgentAvailable.mockImplementationOnce(async () => {
        order.push("wait");
        throw new Error("agent not ready");
      });
      const add = vi.fn(async () => ({ id: "scheduler-daily" }));
      const remove = vi.fn();
      const options = {
        env,
        cronGateway: {
          add,
          remove,
          waitUntilAgentAvailable,
          get: async () => {
            order.push("get");
            return cronReadView("worker", previous);
          },
        },
      };
      const updatePlan = plan([
        {
          kind: "cronJob",
          id: "daily",
          action,
          target: "claw:worker:daily",
          blocked: false,
          reason: "target declaration",
        },
      ]);

      await expect(applyClawCronUpdate(updatePlan, manifest(), options)).rejects.toMatchObject({
        message: "agent not ready",
        partial: false,
      });
      expect(order).toEqual(action === "change" ? ["get", "wait"] : ["wait"]);
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(rows()).toBe(before);

      await expect(applyClawCronUpdate(updatePlan, manifest(), options)).resolves.toMatchObject({
        appliedIds: ["daily"],
      });
      expect(add).toHaveBeenCalledOnce();
      expect(readClawCronRefs("worker", { env })).toMatchObject([
        {
          manifestId: "daily",
          status: "complete",
          schedulerJobId: "scheduler-daily",
          job: newDaily,
        },
      ]);
    },
  );

  it("compensates an earlier removal when later readiness fails without introducing a pending addition", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-readiness-undo-"), "state"),
    };
    const previous = ref(legacy, "scheduler-legacy");
    upsertClawCronRef(previous, { env });
    const waitUntilAgentAvailable = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("agent not ready"));
    const add = vi.fn(async () => ({ id: "scheduler-restored" }));
    const remove = vi.fn();

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "legacy",
            action: "remove",
            target: "scheduler-legacy",
            blocked: false,
            reason: "removed",
          },
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          env,
          nowMs: 20,
          cronGateway: {
            add,
            remove,
            get: async () => cronReadView("worker", previous),
            waitUntilAgentAvailable,
          },
        },
      ),
    ).rejects.toMatchObject({ message: "agent not ready", partial: false });

    expect(remove).toHaveBeenCalledExactlyOnceWith("scheduler-legacy", {
      expectedConfigRevision: cronReadView("worker", previous).configRevision,
    });
    expect(waitUntilAgentAvailable).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledExactlyOnceWith(clawCronGatewayInput("worker", previous));
    expect(readClawCronRefs("worker", { env })).toEqual([
      { ...previous, schedulerJobId: "scheduler-restored", updatedAtMs: 20 },
    ]);
  });

  it("converges changes and reverses add, change, and remove operations", async () => {
    let agentAvailable = false;
    const waitUntilAgentAvailable = vi.fn(async (agentId: string) => {
      expect(agentId).toBe("worker");
      agentAvailable = true;
    });
    const add = vi.fn(
      async (
        input: Record<string, unknown>,
        _options?: { commitGuard?: () => void; existingRef?: PersistedClawCronRef },
      ) => {
        expect(agentAvailable).toBe(true);
        const key = input.declarationKey;
        if (key === "claw:worker:daily") {
          return { id: "scheduler-daily" };
        }
        if (key === "claw:worker:legacy") {
          return { id: "scheduler-legacy-restored" };
        }
        return { id: "scheduler-weekly" };
      },
    );
    const remove = vi.fn(async () => ({ ok: true }));
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
    const refs = [ref(oldDaily, "scheduler-daily"), ref(legacy, "scheduler-legacy")];
    const execution = await applyClawCronUpdate(
      plan([
        {
          kind: "cronJob",
          id: "daily",
          action: "change",
          target: "scheduler-daily",
          blocked: false,
          reason: "changed",
        },
        {
          kind: "cronJob",
          id: "weekly",
          action: "add",
          target: "claw:worker:weekly",
          blocked: false,
          reason: "added",
        },
        {
          kind: "cronJob",
          id: "legacy",
          action: "remove",
          target: "scheduler-legacy",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest(),
      {
        cronGateway: {
          add,
          waitUntilAgentAvailable,
          get: async (id) =>
            cronReadView(
              "worker",
              id === "scheduler-weekly"
                ? ref(weekly, id)
                : refs.find((item) => item.schedulerJobId === id)!,
            ),
          remove,
        },
        readRefs: () => refs,
        upsertRef,
        deleteRef,
        nowMs: 20,
      },
    );

    expect(execution.appliedIds).toEqual(["daily", "weekly", "legacy"]);
    expect(add.mock.calls[0]?.[1]?.existingRef).toEqual(refs[0]);
    expect(remove).toHaveBeenCalledWith("scheduler-legacy", {
      expectedConfigRevision: cronReadView("worker", refs[1]!).configRevision,
    });
    expect(upsertRef).toHaveBeenCalledTimes(5);
    expect(deleteRef).toHaveBeenCalledTimes(1);

    await execution.rollback();

    expect(remove).toHaveBeenCalledWith("scheduler-weekly", {
      expectedConfigRevision: cronReadView("worker", ref(weekly, "scheduler-weekly"))
        .configRevision,
    });
    expect(add).toHaveBeenCalledTimes(4);
    expect(add.mock.calls[3]?.[1]?.existingRef).toMatchObject({
      schedulerJobId: "scheduler-daily",
      status: "complete",
      job: newDaily,
    });
    expect(upsertRef).toHaveBeenCalledTimes(7);
    expect(deleteRef).toHaveBeenCalledTimes(2);
    expect(waitUntilAgentAvailable).toHaveBeenCalledOnce();
  });

  it("removes without waiting and checks availability before compensating add", async () => {
    const previous = ref(legacy, "scheduler-legacy");
    const waitUntilAgentAvailable = vi.fn(async () => undefined);
    const add = vi.fn(async () => {
      expect(waitUntilAgentAvailable).toHaveBeenCalledWith("worker");
      return { id: "scheduler-restored" };
    });
    const upsertRef = vi.fn();
    const execution = await applyClawCronUpdate(
      plan([
        {
          kind: "cronJob",
          id: "legacy",
          action: "remove",
          target: "scheduler-legacy",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest(),
      {
        cronGateway: {
          add,
          get: async () => cronReadView("worker", previous),
          remove: vi.fn(),
          waitUntilAgentAvailable,
        },
        readRefs: () => [previous],
        upsertRef,
        deleteRef: vi.fn(),
      },
    );
    expect(execution.appliedIds).toEqual(["legacy"]);
    expect(waitUntilAgentAvailable).not.toHaveBeenCalled();
    await execution.rollback();
    expect(add).toHaveBeenCalledOnce();
    expect(upsertRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "complete", schedulerJobId: "scheduler-restored" }),
      expect.any(Object),
    );
  });

  it("removes a non-converged replacement and fails closed", async () => {
    const remove = vi.fn(async () => ({ ok: true }));
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "change",
            target: "scheduler-daily",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: async () => ({ id: "unexpected-copy" }),
            get: async (id) =>
              cronReadView("worker", ref(id === "unexpected-copy" ? newDaily : oldDaily, id)),
            remove,
          },
          readRefs: () => [ref(oldDaily, "scheduler-daily")],
          upsertRef: vi.fn(),
        },
      ),
    ).rejects.toThrow("did not converge");
    expect(remove).toHaveBeenCalledWith("unexpected-copy", {
      expectedConfigRevision: cronReadView("worker", ref(newDaily, "unexpected-copy"))
        .configRevision,
    });
  });

  it("preserves a newly added job and its ref when the job changes before rollback", async () => {
    const remove = vi.fn(async () => ({ ok: true }));
    const deleteRef = vi.fn(async () => undefined);
    const execution = await applyClawCronUpdate(
      plan([
        {
          kind: "cronJob",
          id: "weekly",
          action: "add",
          target: "claw:worker:weekly",
          blocked: false,
          reason: "added",
        },
      ]),
      manifest(),
      {
        cronGateway: {
          add: async () => ({ id: "scheduler-weekly" }),
          get: async () =>
            cronReadView(
              "worker",
              ref({ ...weekly, message: "Edited independently" }, "scheduler-weekly"),
            ),
          remove,
        },
        readRefs: () => [],
        upsertRef: vi.fn(async () => undefined),
        deleteRef,
      },
    );

    await expect(execution.rollback()).rejects.toThrow("changed before cleanup");
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it("marks a thrown gateway mutation as uncertain", async () => {
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: async () => {
              throw new Error("connection lost");
            },
            get: vi.fn(),
            remove: vi.fn(),
          },
          readRefs: () => [],
          upsertRef: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ partial: true });
  });

  it("removes a new pending ref when the gateway rejects before scheduler mutation", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-rejected-add-"), "state"),
    };
    const add = vi.fn(async () => {
      throw new ClawCronAddRejectedError(
        "Claw schedule declaration is already in use.",
        "collision",
      );
    });

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          env,
          cronGateway: { add, get: vi.fn(), remove: vi.fn() },
        },
      ),
    ).rejects.toMatchObject({
      message: "Claw schedule declaration is already in use.",
      partial: false,
    });

    expect(add).toHaveBeenCalledOnce();
    expect(readClawCronRefs("worker", { env })).toEqual([]);
  });

  it("restores the prior complete ref when a change is rejected before scheduler mutation", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-rejected-change-"), "state"),
    };
    const previous = ref(oldDaily, "scheduler-daily");
    upsertClawCronRef(previous, { env });
    const add = vi.fn(async () => {
      expect(readClawCronRefs("worker", { env })).toMatchObject([
        { status: "pending", job: newDaily },
      ]);
      throw new ClawCronAddRejectedError("Unconfigured failure route");
    });
    const remove = vi.fn();

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "change",
            target: "scheduler-daily",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          env,
          cronGateway: {
            add,
            get: async () => cronReadView("worker", previous),
            remove,
          },
        },
      ),
    ).rejects.toMatchObject({ message: "Unconfigured failure route", partial: false });

    expect(remove).not.toHaveBeenCalled();
    expect(readClawCronRefs("worker", { env })).toEqual([previous]);
  });

  it("keeps a changed schedule unresolved when its owned job drifts after the read", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-change-drift-"), "state"),
    };
    const previous = ref(oldDaily, "scheduler-daily");
    upsertClawCronRef(previous, { env });
    const add = vi.fn(async () => {
      throw new ClawCronAddRejectedError(
        "Claw schedule declaration changed after planning.",
        "collision",
      );
    });

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "change",
            target: "scheduler-daily",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          env,
          cronGateway: {
            add,
            get: async () => cronReadView("worker", previous),
            remove: vi.fn(),
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "Claw schedule declaration changed after planning.",
      partial: true,
    });

    expect(add).toHaveBeenCalledOnce();
    expect(readClawCronRefs("worker", { env })).toMatchObject([
      { manifestId: "daily", status: "pending", job: newDaily },
    ]);
  });

  it("retains pending provenance when rejection cleanup fails", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-rejected-cleanup-"), "state"),
    };

    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          env,
          deleteRef: async () => {
            throw new Error("state store unavailable");
          },
          cronGateway: {
            add: async () => {
              throw new ClawCronAddRejectedError("Claw schedule declaration is already in use.");
            },
            get: vi.fn(),
            remove: vi.fn(),
          },
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("state store unavailable"),
      partial: true,
    });

    expect(readClawCronRefs("worker", { env })).toMatchObject([
      { manifestId: "weekly", status: "pending" },
    ]);
  });

  it("rejects a live cron definition changed after planning", async () => {
    const remove = vi.fn();
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "legacy",
            action: "remove",
            target: "scheduler-legacy",
            blocked: false,
            reason: "removed",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: vi.fn(),
            get: async () => ({
              ...cronReadView("worker", ref(legacy, "scheduler-legacy")),
              payload: { kind: "agentTurn", message: "Operator edit" },
            }),
            remove,
          },
          readRefs: () => [ref(legacy, "scheduler-legacy")],
        },
      ),
    ).rejects.toThrow("changed after planning");
    expect(remove).not.toHaveBeenCalled();
  });
});
