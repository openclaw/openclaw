import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createDurableJobRecord,
  createDurableJobTransitionDisposition,
  getDurableJobById,
  listDurableJobTransitions,
  recordDurableJobTransition,
  resetDurableJobRegistryForTests,
  updateDurableJobRecordByIdExpectedRevision,
} from "./durable-job-registry.js";
import {
  resolveDurableJobRegistryDir,
  resolveDurableJobRegistrySqlitePath,
} from "./durable-job-registry.paths.js";
import { configureDurableJobRegistryRuntime } from "./durable-job-registry.store.js";
import type { DurableJobRecord, DurableJobTransitionRecord } from "./durable-job-registry.types.js";

function createStoredJob(): DurableJobRecord {
  return {
    jobId: "job-restored",
    title: "Restored durable job",
    goal: "Resume after restore",
    ownerSessionKey: "agent:main:main",
    requesterOrigin: {
      channel: "slack",
      to: "user:U123",
    },
    source: {
      kind: "chat_commitment",
      messageText: "I'll keep watching this",
    },
    status: "waiting",
    stopCondition: {
      kind: "custom",
      details: "Stop when the PR is clean",
    },
    notifyPolicy: {
      kind: "state_changes",
      onCompletion: true,
    },
    currentStep: "wait_for_next_wake",
    summary: "Waiting for the next review cycle.",
    nextWakeAt: 333,
    lastUserUpdateAt: 320,
    backing: {
      taskFlowId: "flow-restored",
      cronJobIds: ["cron-restored"],
      childTaskIds: ["task-restored"],
      childSessionKeys: ["agent:coder:subagent:1"],
    },
    audit: {
      createdAt: 100,
      updatedAt: 321,
      createdBy: "assistant",
      revision: 4,
    },
  };
}

function createStoredTransition(): DurableJobTransitionRecord {
  return {
    transitionId: "jobtx-restored",
    jobId: "job-restored",
    from: "running",
    to: "waiting",
    reason: "Waiting for the next sweep",
    actor: "assistant",
    at: 321,
    disposition: {
      kind: "notify_and_schedule",
      notification: {
        status: "sent",
      },
      wake: {
        status: "scheduled",
        nextWakeAt: 333,
      },
    },
    revision: 4,
  };
}

async function withDurableJobRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-durable-job-store-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetDurableJobRegistryForTests();
    try {
      return await run(root);
    } finally {
      resetDurableJobRegistryForTests();
    }
  });
}

describe("durable-job-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    resetDurableJobRegistryForTests();
  });

  it("uses the configured durable-job store for restore and save", () => {
    const storedJob = createStoredJob();
    const storedTransition = createStoredTransition();
    const loadSnapshot = vi.fn(() => ({
      jobs: new Map([[storedJob.jobId, storedJob]]),
      transitionsByJobId: new Map([[storedJob.jobId, [storedTransition]]]),
    }));
    const saveSnapshot = vi.fn();
    configureDurableJobRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(getDurableJobById("job-restored")).toMatchObject({
      jobId: "job-restored",
      status: "waiting",
      backing: {
        taskFlowId: "flow-restored",
      },
      audit: {
        revision: 4,
      },
    });
    expect(listDurableJobTransitions("job-restored")).toEqual([
      expect.objectContaining({
        transitionId: "jobtx-restored",
        to: "waiting",
      }),
    ]);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createDurableJobRecord({
      jobId: "job-new",
      title: "New durable job",
      goal: "Create a narrow persistence proof",
      ownerSessionKey: "agent:main:main",
      status: "planned",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      createdBy: "tests",
      createdAt: 400,
      updatedAt: 400,
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      jobs: ReadonlyMap<string, DurableJobRecord>;
      transitionsByJobId: ReadonlyMap<string, DurableJobTransitionRecord[]>;
    };
    expect(latestSnapshot.jobs.size).toBe(2);
    expect(latestSnapshot.transitionsByJobId.get("job-restored")?.[0]?.transitionId).toBe(
      "jobtx-restored",
    );
  });

  it("persists backing links and transition history through sqlite", async () => {
    await withDurableJobRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetDurableJobRegistryForTests();

      const created = createDurableJobRecord({
        title: "Persist durable job",
        goal: "Round-trip taskflow linkage",
        ownerSessionKey: "agent:main:main",
        status: "running",
        stopCondition: { kind: "custom", details: "Stop when the patch lands" },
        notifyPolicy: { kind: "state_changes", onCompletion: true },
        currentStep: "review_comments",
        summary: "Initial cycle running",
        nextWakeAt: 500,
        lastUserUpdateAt: 450,
        backing: {
          taskFlowId: "flow-persisted",
          cronJobIds: ["cron-persisted"],
          childTaskIds: ["task-persisted"],
          childSessionKeys: ["agent:coder:subagent:durable"],
        },
        source: { kind: "chat_commitment", messageText: "I'll keep this moving." },
        requesterOrigin: {
          channel: "slack",
          to: "user:U123",
        },
        createdBy: "tests",
        createdAt: 400,
        updatedAt: 410,
      });
      const updated = updateDurableJobRecordByIdExpectedRevision({
        jobId: created.jobId,
        expectedRevision: created.audit.revision,
        patch: {
          status: "waiting",
          currentStep: "await_next_wake",
          summary: "Waiting after first pass",
          nextWakeAt: 900,
        },
        updatedAt: 420,
      });
      expect(updated).toMatchObject({ applied: true });
      const revision = updated.applied ? updated.job.audit.revision : -1;
      recordDurableJobTransition({
        jobId: created.jobId,
        from: "running",
        to: "waiting",
        reason: "Waiting for the next wake",
        actor: "assistant",
        at: 421,
        disposition: {
          kind: "notify_and_schedule",
          notification: { status: "sent" },
          wake: { status: "scheduled", nextWakeAt: 900 },
        },
        revision,
      });

      resetDurableJobRegistryForTests({ persist: false });

      expect(getDurableJobById(created.jobId)).toMatchObject({
        jobId: created.jobId,
        status: "waiting",
        currentStep: "await_next_wake",
        nextWakeAt: 900,
        backing: {
          taskFlowId: "flow-persisted",
          cronJobIds: ["cron-persisted"],
          childTaskIds: ["task-persisted"],
          childSessionKeys: ["agent:coder:subagent:durable"],
        },
        source: {
          kind: "chat_commitment",
        },
        requesterOrigin: {
          channel: "slack",
        },
        audit: {
          revision: 1,
        },
      });
      expect(listDurableJobTransitions(created.jobId)).toEqual([
        expect.objectContaining({
          jobId: created.jobId,
          from: "running",
          to: "waiting",
          revision: 1,
        }),
      ]);
    });
  });

  it("hardens the sqlite durable-job store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withDurableJobRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetDurableJobRegistryForTests();

      createDurableJobRecord({
        title: "Secure durable job store",
        goal: "Verify durable job sqlite permissions",
        ownerSessionKey: "agent:main:main",
        stopCondition: { kind: "manual" },
        notifyPolicy: { kind: "state_changes" },
      });

      const registryDir = resolveDurableJobRegistryDir(process.env);
      const sqlitePath = resolveDurableJobRegistrySqlitePath(process.env);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });

  it("builds canonical dispositions from notification and wake results", () => {
    expect(
      createDurableJobTransitionDisposition({
        notification: { status: "sent" },
        wake: { status: "scheduled", nextWakeAt: 333 },
      }),
    ).toEqual({
      kind: "notify_and_schedule",
      notification: { status: "sent" },
      wake: { status: "scheduled", nextWakeAt: 333 },
    });

    expect(
      createDurableJobTransitionDisposition({
        wake: { status: "cleared", detail: "No retry needed" },
      }),
    ).toEqual({
      kind: "clear_wake_only",
      wake: { status: "cleared", detail: "No retry needed" },
    });

    expect(createDurableJobTransitionDisposition({})).toBeUndefined();
  });

  it("requires an explicit disposition for important transitions", () => {
    const created = createDurableJobRecord({
      jobId: "job-disposition-required",
      title: "Disposition required",
      goal: "Reject waiting transitions without a structured disposition",
      ownerSessionKey: "agent:main:main",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
    });

    expect(() =>
      recordDurableJobTransition({
        jobId: created.jobId,
        from: "running",
        to: "waiting",
      }),
    ).toThrow("Durable job transition to waiting requires an explicit disposition.");
  });
});
