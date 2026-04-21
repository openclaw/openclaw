import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDurableJobRecord,
  recordDurableJobTransition,
  resetDurableJobRegistryForTests,
  updateDurableJobRecordByIdExpectedRevision,
} from "../tasks/runtime-internal.js";
import { jobsListCommand, jobsShowCommand } from "./jobs.js";

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("jobs commands", () => {
  beforeEach(() => {
    resetDurableJobRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetDurableJobRegistryForTests({ persist: false });
  });

  it("lists durable jobs with filters in json mode", async () => {
    createDurableJobRecord({
      jobId: "job-running",
      title: "Watch PR",
      goal: "Keep checking review comments",
      ownerSessionKey: "agent:main:main",
      status: "running",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
      currentStep: "review_comments",
      summary: "Cycle 1",
      backing: { taskFlowId: "flow-123" },
    });
    createDurableJobRecord({
      jobId: "job-waiting",
      title: "Wait for reply",
      goal: "Hold until user answers",
      ownerSessionKey: "agent:main:other",
      status: "waiting",
      stopCondition: { kind: "manual" },
      notifyPolicy: { kind: "state_changes" },
    });

    const runtime = createRuntime();
    await jobsListCommand(
      {
        json: true,
        status: "running",
        owner: "agent:main:main",
      },
      runtime as never,
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runtime.log.mock.calls[0][0])).toEqual(
      expect.objectContaining({
        count: 1,
        status: "running",
        owner: "agent:main:main",
        jobs: [expect.objectContaining({ jobId: "job-running", status: "running" })],
      }),
    );
  });

  it("shows one durable job with transition history", async () => {
    const created = createDurableJobRecord({
      jobId: "job-123",
      title: "Monitor issue",
      goal: "Track until complete",
      ownerSessionKey: "agent:main:main",
      status: "planned",
      stopCondition: { kind: "manual", details: "Done when issue closes" },
      notifyPolicy: { kind: "state_changes" },
      summary: "Created",
    });
    const updated = updateDurableJobRecordByIdExpectedRevision({
      jobId: created.jobId,
      expectedRevision: created.audit.revision,
      patch: {
        status: "running",
        currentStep: "polling",
        summary: "Started polling",
        backing: { taskFlowId: "flow-123" },
      },
      updatedAt: 200,
    });
    if (!updated.applied) {
      throw new Error("expected durable job update to apply");
    }
    recordDurableJobTransition({
      jobId: created.jobId,
      from: "planned",
      to: "running",
      actor: "assistant",
      reason: "Started monitoring",
      at: 200,
      revision: updated.job.audit.revision,
    });

    const runtime = createRuntime();
    await jobsShowCommand({ jobId: "job-123" }, runtime as never);

    const output = runtime.log.mock.calls.map((call) => String(call[0]));
    expect(output).toContain("Durable job:");
    expect(output).toContain("jobId: job-123");
    expect(output).toContain("taskFlowId: flow-123");
    expect(output).toContain("historyCount: 1");
    expect(
      output.some((line) => line.startsWith("- 1970-01-01T00:00:00.200Z planned -> running")),
    ).toBe(true);
  });

  it("returns a clear not-found error for unknown jobs", async () => {
    const runtime = createRuntime();
    await jobsShowCommand({ jobId: "missing-job" }, runtime as never);

    expect(runtime.error).toHaveBeenCalledWith("Durable job not found: missing-job");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
