import { describe, expect, it, vi } from "vitest";
import { applyClawCronUpdate } from "./cron-update.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron.js";
import { CLAW_OUTPUT_STABILITY, type ClawCronJob, type ClawManifest } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

const oldDaily: ClawCronJob = {
  id: "daily",
  schedule: { cron: "0 9 * * *" },
  session: "main",
  message: "Old daily",
};
const newDaily: ClawCronJob = { ...oldDaily, message: "New daily" };
const legacy: ClawCronJob = {
  id: "legacy",
  schedule: { cron: "0 8 * * *" },
  session: "isolated",
  message: "Legacy",
};
const weekly: ClawCronJob = {
  id: "weekly",
  schedule: { cron: "0 9 * * 1" },
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

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
    },
    actions,
    blockers: [],
    diagnostics: [],
  };
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
  it("converges changes and reverses add, change, and remove operations", async () => {
    const add = vi.fn(async (input: Record<string, unknown>) => {
      const key = input.declarationKey;
      if (key === "claw:worker:daily") {
        return { id: "scheduler-daily" };
      }
      if (key === "claw:worker:legacy") {
        return { id: "scheduler-legacy-restored" };
      }
      return { id: "scheduler-weekly" };
    });
    const remove = vi.fn(async () => ({ ok: true }));
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
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
        cronGateway: { add, remove },
        readRefs: () => [ref(oldDaily, "scheduler-daily"), ref(legacy, "scheduler-legacy")],
        upsertRef,
        deleteRef,
        nowMs: 20,
      },
    );

    expect(execution.appliedIds).toEqual(["daily", "weekly", "legacy"]);
    expect(remove).toHaveBeenCalledWith("scheduler-legacy");
    expect(upsertRef).toHaveBeenCalledTimes(2);
    expect(deleteRef).toHaveBeenCalledTimes(1);

    await execution.rollback();

    expect(remove).toHaveBeenCalledWith("scheduler-weekly");
    expect(add).toHaveBeenCalledTimes(4);
    expect(upsertRef).toHaveBeenCalledTimes(4);
    expect(deleteRef).toHaveBeenCalledTimes(2);
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
          cronGateway: { add: async () => ({ id: "unexpected-copy" }), remove },
          readRefs: () => [ref(oldDaily, "scheduler-daily")],
        },
      ),
    ).rejects.toThrow("did not converge");
    expect(remove).toHaveBeenCalledWith("unexpected-copy");
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
            remove: vi.fn(),
          },
          readRefs: () => [],
        },
      ),
    ).rejects.toMatchObject({ partial: true });
  });
});
