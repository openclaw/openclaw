import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTaskFlowById } from "../../tasks/task-flow-registry.js";
import { getTaskById } from "../../tasks/task-registry.js";
import * as runtimeJobsModule from "./runtime-jobs.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";

const { createRuntimeJobs } = runtimeJobsModule;
afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("runtime TaskFlow", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("binds managed TaskFlow operations to a session key", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });

    const created = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Triage inbox",
      currentStep: "classify",
      stateJson: { lane: "inbox" },
    });

    expect(created).toMatchObject({
      syncMode: "managed",
      ownerKey: "agent:main:main",
      controllerId: "tests/runtime-taskflow",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
      goal: "Triage inbox",
    });
    expect(taskFlow.get(created.flowId)?.flowId).toBe(created.flowId);
    expect(taskFlow.findLatest()?.flowId).toBe(created.flowId);
    expect(taskFlow.resolve("agent:main:main")?.flowId).toBe(created.flowId);
  });

  it("binds TaskFlows from trusted tool context", () => {
    const runtime = createRuntimeTaskFlow();
    const taskFlow = runtime.fromToolContext({
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        threadId: "thread:456",
      },
    });

    const created = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Review queue",
    });

    expect(created.requesterOrigin).toMatchObject({
      channel: "discord",
      to: "channel:123",
      threadId: "thread:456",
    });
  });

  it("rejects tool contexts without a bound session key", () => {
    const runtime = createRuntimeTaskFlow();
    expect(() =>
      runtime.fromToolContext({
        sessionKey: undefined,
        deliveryContext: undefined,
      }),
    ).toThrow("TaskFlow runtime requires tool context with a sessionKey.");
  });

  it("keeps TaskFlow reads owner-scoped and runs child tasks under the bound TaskFlow", () => {
    const runtime = createRuntimeTaskFlow();
    const ownerTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlow = runtime.bindSession({
      sessionKey: "agent:main:other",
    });

    const created = ownerTaskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Inspect PR batch",
    });

    expect(otherTaskFlow.get(created.flowId)).toBeUndefined();
    expect(otherTaskFlow.list()).toEqual([]);

    const child = ownerTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-taskflow-child",
      task: "Inspect PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 10,
    });

    expect(child).toMatchObject({
      created: true,
      flow: expect.objectContaining({
        flowId: created.flowId,
      }),
      task: expect.objectContaining({
        parentFlowId: created.flowId,
        ownerKey: "agent:main:main",
        runId: "runtime-taskflow-child",
      }),
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }
    expect(getTaskById(child.task.taskId)).toMatchObject({
      parentFlowId: created.flowId,
      ownerKey: "agent:main:main",
    });
    expect(getTaskFlowById(created.flowId)).toMatchObject({
      flowId: created.flowId,
    });
    expect(ownerTaskFlow.getTaskSummary(created.flowId)).toMatchObject({
      total: 1,
      active: 1,
    });
  });

  it("syncs an attached durable job when a managed flow moves into waiting with a next wake", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Watch linked TaskFlow",
      goal: "Mirror TaskFlow waiting state into durable jobs",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "triage",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Wait for the next wake",
      currentStep: "triage",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const waiting = taskFlow.setWaiting({
      flowId: createdFlow.flowId,
      expectedRevision: createdFlow.revision,
      currentStep: "await_next_wake",
      waitJson: {
        kind: "wake",
        nextWakeAt: 500,
      },
      updatedAt: 50,
    });

    expect(waiting).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "waiting",
        currentStep: "await_next_wake",
      }),
    });

    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "waiting",
      currentStep: "await_next_wake",
      nextWakeAt: 500,
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([
      expect.objectContaining({
        from: "running",
        to: "waiting",
        reason: "Awaiting next wake",
        disposition: {
          kind: "schedule_only",
          wake: { status: "scheduled", nextWakeAt: 500 },
        },
      }),
    ]);
  });

  it("clears stale wake state and preserves nullish blocked summary while waiting", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Clear waiting wake state",
      goal: "Mirror waiting TaskFlow state without leaving a stale wake behind",
      status: "waiting",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "await_review",
      summary: "Previously blocked on review",
      nextWakeAt: 500,
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Stay waiting on a non-wake condition",
      currentStep: "await_review",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const waiting = taskFlow.setWaiting({
      flowId: createdFlow.flowId,
      expectedRevision: createdFlow.revision,
      currentStep: "await_review",
      waitJson: {
        kind: "blocked",
        detail: "Still waiting on reviewer feedback",
      },
      blockedSummary: null,
      updatedAt: 50,
    });

    expect(waiting).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "waiting",
        currentStep: "await_review",
      }),
    });
    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "waiting",
      currentStep: "await_review",
      nextWakeAt: undefined,
      summary: undefined,
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([]);
  });

  it("surfaces linked durable-job sync failures during waiting transitions", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Linked job sync error",
      goal: "Surface sync failures instead of silently drifting",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "triage",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Propagate linked durable-job sync failures",
      currentStep: "triage",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const currentJob = jobs.get(createdJob.jobId);
    if (!currentJob) {
      throw new Error("expected linked durable job to exist");
    }

    const transition = vi.fn(() => ({
      applied: false as const,
      reason: "revision_conflict" as const,
      current: {
        ...currentJob,
        audit: {
          ...currentJob.audit,
          revision: 7,
        },
      },
    }));
    const update = vi.fn(() => ({ applied: true as const, job: {} as never }));
    const bindSession = vi.fn(() => ({
      ...jobs,
      update,
      transition,
    }));
    const jobsSpy = vi
      .spyOn(runtimeJobsModule, "createRuntimeJobs")
      .mockReturnValue({ bindSession, fromToolContext: bindSession });

    try {
      expect(() =>
        taskFlow.setWaiting({
          flowId: createdFlow.flowId,
          expectedRevision: createdFlow.revision,
          currentStep: "await_next_wake",
          waitJson: { kind: "wake", nextWakeAt: 500 },
          updatedAt: 50,
        }),
      ).toThrow(
        "Linked durable job sync failed during TaskFlow waiting transition: revision_conflict",
      );

      expect(transition).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
    } finally {
      jobsSpy.mockRestore();
    }
  });

  it("syncs an attached durable job back to running when a managed flow resumes", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Resume linked TaskFlow",
      goal: "Mirror TaskFlow resume state into durable jobs",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "triage",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Resume after waiting",
      currentStep: "triage",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const waiting = taskFlow.setWaiting({
      flowId: createdFlow.flowId,
      expectedRevision: createdFlow.revision,
      currentStep: "await_next_wake",
      waitJson: {
        kind: "wake",
        nextWakeAt: 500,
      },
      updatedAt: 50,
    });
    expect(waiting).toMatchObject({ applied: true });
    if (!waiting.applied) {
      throw new Error("expected waiting transition to succeed");
    }

    const resumed = taskFlow.resume({
      flowId: createdFlow.flowId,
      expectedRevision: waiting.flow.revision,
      status: "running",
      currentStep: "continue_work",
      updatedAt: 75,
    });

    expect(resumed).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "running",
        currentStep: "continue_work",
        waitJson: null,
      }),
    });

    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "running",
      currentStep: "continue_work",
      nextWakeAt: undefined,
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([
      expect.objectContaining({
        from: "running",
        to: "waiting",
        reason: "Awaiting next wake",
        disposition: {
          kind: "schedule_only",
          wake: { status: "scheduled", nextWakeAt: 500 },
        },
      }),
      expect.objectContaining({
        from: "waiting",
        to: "running",
        reason: "Resumed linked TaskFlow",
        disposition: {
          kind: "clear_wake_only",
          wake: { status: "cleared", detail: "TaskFlow resumed into running." },
        },
      }),
    ]);
  });

  it("syncs an attached durable job to completed when a managed flow finishes", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Finish linked TaskFlow",
      goal: "Mirror TaskFlow completion into durable jobs",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "triage",
      nextWakeAt: 500,
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Finish after work completes",
      currentStep: "triage",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });
    if (!attached.applied) {
      throw new Error("expected TaskFlow attachment to succeed");
    }

    const finished = taskFlow.finish({
      flowId: createdFlow.flowId,
      expectedRevision: createdFlow.revision,
      updatedAt: 75,
      endedAt: 80,
    });

    expect(finished).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "succeeded",
        endedAt: 80,
      }),
    });

    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "completed",
      nextWakeAt: undefined,
      summary: undefined,
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([
      expect.objectContaining({
        from: "running",
        to: "completed",
        reason: "Linked TaskFlow finished",
        disposition: {
          kind: "clear_wake_only",
          wake: { status: "cleared", detail: "TaskFlow reached a successful terminal state." },
        },
      }),
    ]);
  });

  it("syncs an attached durable job to blocked when a managed flow fails", () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Fail linked TaskFlow",
      goal: "Mirror TaskFlow failure into durable jobs",
      status: "waiting",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "await_review",
      nextWakeAt: 500,
      summary: "Waiting on review",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Fail after review",
      currentStep: "await_review",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });
    if (!attached.applied) {
      throw new Error("expected TaskFlow attachment to succeed");
    }

    const failed = taskFlow.fail({
      flowId: createdFlow.flowId,
      expectedRevision: createdFlow.revision,
      blockedSummary: "Reviewer denied the change.",
      updatedAt: 90,
      endedAt: 95,
    });

    expect(failed).toMatchObject({
      applied: true,
      flow: expect.objectContaining({
        status: "failed",
        blockedSummary: "Reviewer denied the change.",
        endedAt: 95,
      }),
    });

    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "blocked",
      nextWakeAt: undefined,
      summary: "Reviewer denied the change.",
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([
      expect.objectContaining({
        from: "waiting",
        to: "blocked",
        reason: "Linked TaskFlow failed",
        disposition: {
          kind: "clear_wake_only",
          wake: { status: "cleared", detail: "TaskFlow reached a failed terminal state." },
        },
      }),
    ]);
  });

  it("syncs an attached durable job to cancelled when a managed flow is cancelled", async () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Cancel linked TaskFlow",
      goal: "Mirror TaskFlow cancellation into durable jobs",
      status: "waiting",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "await_next_wake",
      nextWakeAt: 500,
      summary: "Waiting on next wake",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Cancel after waiting",
      currentStep: "await_next_wake",
      updatedAt: 40,
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const cancelled = await taskFlow.cancel({
      flowId: createdFlow.flowId,
      cfg: {} as never,
    });

    expect(cancelled).toMatchObject({
      found: true,
      cancelled: true,
      flow: expect.objectContaining({
        status: "cancelled",
      }),
    });

    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "cancelled",
      currentStep: "await_next_wake",
      nextWakeAt: undefined,
      summary: undefined,
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([
      expect.objectContaining({
        from: "waiting",
        to: "cancelled",
        reason: "Linked TaskFlow cancelled",
        disposition: {
          kind: "clear_wake_only",
          wake: { status: "cleared", detail: "TaskFlow cancellation cleared any pending wake." },
        },
      }),
    ]);
  });

  it("preserves an attached durable job that was already moved into a terminal state manually", async () => {
    const taskFlowRuntime = createRuntimeTaskFlow();
    const jobsRuntime = createRuntimeJobs();
    const taskFlow = taskFlowRuntime.bindSession({
      sessionKey: "agent:main:main",
    });
    const jobs = jobsRuntime.bindSession({
      sessionKey: "agent:main:main",
    });

    const createdJob = jobs.create({
      title: "Keep manual terminal durable job",
      goal: "Do not overwrite manual durable-job terminal states during TaskFlow cancellation",
      status: "blocked",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      summary: "Operator blocked this job manually",
    });
    const createdFlow = taskFlow.createManaged({
      controllerId: "tests/runtime-taskflow",
      goal: "Cancel without touching manual durable-job terminal state",
    });

    const attached = jobs.attachTaskFlow({
      jobId: createdJob.jobId,
      flowId: createdFlow.flowId,
      expectedRevision: createdJob.audit.revision,
      updatedAt: 25,
    });
    expect(attached).toMatchObject({ applied: true });

    const cancelled = await taskFlow.cancel({
      flowId: createdFlow.flowId,
      cfg: {} as never,
    });

    expect(cancelled).toMatchObject({
      found: true,
      cancelled: true,
      flow: expect.objectContaining({
        status: "cancelled",
      }),
    });
    expect(jobs.get(createdJob.jobId)).toMatchObject({
      status: "blocked",
      summary: "Operator blocked this job manually",
      backing: expect.objectContaining({ taskFlowId: createdFlow.flowId }),
    });
    expect(jobs.history(createdJob.jobId)).toEqual([]);
  });
});
