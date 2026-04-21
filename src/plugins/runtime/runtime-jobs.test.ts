import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDurableJobRegistryForTests } from "../../tasks/durable-job-runtime-internal.js";
import { createManagedTaskFlow } from "../../tasks/task-flow-registry.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createRuntimeJobs } from "./runtime-jobs.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";

afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("runtime jobs", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("creates, updates, transitions, and reads owner-scoped durable jobs", () => {
    const runtime = createRuntimeJobs();
    const jobs = runtime.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "slack",
        to: "user:U123",
      },
    });
    const otherJobs = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = jobs.create({
      title: "Monitor PR 121",
      goal: "Keep checking until the review queue is clean",
      status: "planned",
      stopCondition: { kind: "custom", details: "Stop when no substantive comments remain" },
      notifyPolicy: { kind: "state_changes", onCompletion: true },
      source: { kind: "chat_commitment", messageText: "I'll keep watching this." },
      currentStep: "start",
      summary: "Created from runtime test",
    });

    expect(created).toMatchObject({
      ownerSessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "slack",
      },
      audit: {
        revision: 0,
      },
    });
    expect(otherJobs.get(created.jobId)).toBeUndefined();
    expect(otherJobs.list()).toEqual([]);

    const updated = jobs.update({
      jobId: created.jobId,
      expectedRevision: created.audit.revision,
      patch: {
        status: "running",
        currentStep: "review_comments",
        summary: "Cycle 1 running",
      },
      updatedAt: 100,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        applied: true,
        job: expect.objectContaining({
          status: "running",
          currentStep: "review_comments",
          audit: expect.objectContaining({ revision: 1, updatedAt: 100 }),
        }),
      }),
    );
    if (!updated.applied) {
      throw new Error("expected update to succeed");
    }

    const transitioned = jobs.transition({
      jobId: created.jobId,
      expectedRevision: updated.job.audit.revision,
      from: "running",
      to: "waiting",
      reason: "Waiting for the next sweep",
      actor: "assistant",
      at: 200,
      disposition: {
        kind: "notify_and_schedule",
        notification: {
          status: "sent",
        },
        wake: {
          status: "scheduled",
          nextWakeAt: 300,
        },
      },
      patch: {
        currentStep: "await_next_wake",
        nextWakeAt: 300,
        summary: "Waiting for the next review cycle",
      },
    });

    expect(transitioned).toEqual(
      expect.objectContaining({
        applied: true,
        job: expect.objectContaining({
          status: "waiting",
          currentStep: "await_next_wake",
          nextWakeAt: 300,
          audit: expect.objectContaining({ revision: 2, updatedAt: 200 }),
        }),
        transition: expect.objectContaining({
          from: "running",
          to: "waiting",
          revision: 2,
        }),
      }),
    );
    expect(jobs.history(created.jobId)).toEqual([
      expect.objectContaining({
        jobId: created.jobId,
        from: "running",
        to: "waiting",
      }),
    ]);
  });

  it("attaches owned TaskFlows and rejects cross-owner access and stale mutations", () => {
    const runtime = createRuntimeJobs();
    const jobs = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherJobs = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = jobs.create({
      title: "Keep a durable wrapper over TaskFlow",
      goal: "Attach a managed flow id",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
    });

    const ownedFlow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/runtime-jobs",
      goal: "Owned flow",
    });
    const otherFlow = createManagedTaskFlow({
      ownerKey: "agent:main:other",
      controllerId: "tests/runtime-jobs",
      goal: "Foreign flow",
    });

    expect(
      jobs.attachTaskFlow({
        jobId: created.jobId,
        flowId: ownedFlow.flowId,
        expectedRevision: created.audit.revision,
        updatedAt: 500,
      }),
    ).toEqual(
      expect.objectContaining({
        applied: true,
        job: expect.objectContaining({
          backing: expect.objectContaining({ taskFlowId: ownedFlow.flowId }),
          audit: expect.objectContaining({ revision: 1, updatedAt: 500 }),
        }),
      }),
    );

    expect(
      jobs.attachTaskFlow({
        jobId: created.jobId,
        flowId: otherFlow.flowId,
        expectedRevision: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        applied: false,
        reason: "taskflow_not_found",
      }),
    );

    expect(
      otherJobs.update({
        jobId: created.jobId,
        expectedRevision: 1,
        patch: { summary: "should not leak" },
      }),
    ).toEqual({
      applied: false,
      reason: "not_found",
    });

    expect(
      jobs.update({
        jobId: created.jobId,
        expectedRevision: 0,
        patch: { summary: "stale" },
      }),
    ).toEqual(
      expect.objectContaining({
        applied: false,
        reason: "revision_conflict",
        current: expect.objectContaining({
          audit: expect.objectContaining({ revision: 1 }),
        }),
      }),
    );
  });

  it("restores owner-scoped list, get, and history after registry reload", async () => {
    await withTempDir({ prefix: "openclaw-runtime-jobs-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetRuntimeTaskTestState();
      installRuntimeTaskDeliveryMock();

      const runtime = createRuntimeJobs();
      const jobs = runtime.bindSession({
        sessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "slack",
          to: "user:U123",
        },
      });
      const otherJobs = runtime.bindSession({
        sessionKey: "agent:main:other",
      });

      const created = jobs.create({
        title: "Persisted runtime job",
        goal: "Restore through owner-scoped runtime helpers",
        status: "running",
        stopCondition: { kind: "manual" },
        notifyPolicy: { kind: "state_changes", onWaiting: true },
        currentStep: "first_pass",
        summary: "Before reload",
      });
      const transitioned = jobs.transition({
        jobId: created.jobId,
        expectedRevision: created.audit.revision,
        from: "running",
        to: "waiting",
        reason: "Awaiting next wake",
        actor: "assistant",
        at: 220,
        disposition: {
          kind: "notify_and_schedule",
          notification: { status: "sent" },
          wake: { status: "scheduled", nextWakeAt: 500 },
        },
        patch: {
          currentStep: "await_next_wake",
          summary: "Waiting after persisted reload",
          nextWakeAt: 500,
        },
      });
      expect(transitioned).toMatchObject({ applied: true });

      resetDurableJobRegistryForTests({ persist: false });

      const reloadedRuntime = createRuntimeJobs();
      const reloadedJobs = reloadedRuntime.bindSession({ sessionKey: "agent:main:main" });
      const reloadedOtherJobs = reloadedRuntime.bindSession({ sessionKey: "agent:main:other" });

      expect(reloadedJobs.list()).toEqual([
        expect.objectContaining({
          jobId: created.jobId,
          status: "waiting",
          currentStep: "await_next_wake",
          nextWakeAt: 500,
          audit: expect.objectContaining({ revision: 1 }),
        }),
      ]);
      expect(reloadedJobs.get(created.jobId)).toEqual(
        expect.objectContaining({
          jobId: created.jobId,
          ownerSessionKey: "agent:main:main",
          requesterOrigin: expect.objectContaining({ channel: "slack" }),
        }),
      );
      expect(reloadedJobs.history(created.jobId)).toEqual([
        expect.objectContaining({
          from: "running",
          to: "waiting",
          reason: "Awaiting next wake",
          revision: 1,
        }),
      ]);
      expect(reloadedOtherJobs.get(created.jobId)).toBeUndefined();
      expect(reloadedOtherJobs.list()).toEqual([]);
      expect(reloadedOtherJobs.history(created.jobId)).toEqual([]);
      expect(otherJobs.list()).toEqual([]);
    });
  });

  it("derives a canonical disposition from notification and wake inputs", () => {
    const runtime = createRuntimeJobs();
    const jobs = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = jobs.create({
      title: "Derived disposition",
      goal: "Allow callers to pass notification and wake results directly",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
    });

    const transitioned = jobs.transition({
      jobId: created.jobId,
      expectedRevision: created.audit.revision,
      from: "running",
      to: "waiting",
      reason: "Waiting for the next wake",
      notification: { status: "sent" },
      wake: { status: "scheduled", nextWakeAt: 450 },
      patch: {
        currentStep: "await_next_wake",
        nextWakeAt: 450,
      },
      at: 300,
    });

    expect(transitioned).toEqual(
      expect.objectContaining({
        applied: true,
        transition: expect.objectContaining({
          disposition: {
            kind: "notify_and_schedule",
            notification: { status: "sent" },
            wake: { status: "scheduled", nextWakeAt: 450 },
          },
        }),
      }),
    );
  });

  it("rejects invalid owner binding and tool contexts without session keys", () => {
    const runtime = createRuntimeJobs();
    const jobs = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    expect(() =>
      jobs.create({
        ownerSessionKey: "agent:main:other",
        title: "Bad owner override",
        goal: "Should be rejected",
        stopCondition: { kind: "manual" },
        notifyPolicy: { kind: "state_changes" },
      }),
    ).toThrow("Durable jobs runtime is owner-scoped to the bound sessionKey.");

    expect(() =>
      runtime.fromToolContext({
        sessionKey: undefined,
        deliveryContext: undefined,
      }),
    ).toThrow("Durable jobs runtime requires tool context with a sessionKey.");
  });

  it("requires an explicit disposition for important transitions", () => {
    const runtime = createRuntimeJobs();
    const jobs = runtime.bindSession({
      sessionKey: "agent:main:main",
    });

    const created = jobs.create({
      title: "Wait for reviewer",
      goal: "Move into waiting only with an explicit disposition",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
    });

    expect(
      jobs.transition({
        jobId: created.jobId,
        expectedRevision: created.audit.revision,
        from: "running",
        to: "waiting",
      }),
    ).toEqual(
      expect.objectContaining({
        applied: false,
        reason: "disposition_required",
        current: expect.objectContaining({
          jobId: created.jobId,
          status: "running",
        }),
      }),
    );
  });
});
