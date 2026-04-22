import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDurableJobRecord,
  recordDurableJobTransition,
  resetDurableJobRegistryForTests,
  updateDurableJobRecordByIdExpectedRevision,
} from "../tasks/runtime-internal.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
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

  it("returns persisted jobs and transition history after reload", async () => {
    await withTempDir({ prefix: "openclaw-jobs-command-" }, async (root) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = root;
      resetDurableJobRegistryForTests();

      try {
        const created = createDurableJobRecord({
          jobId: "job-reload",
          title: "Reload durable job",
          goal: "Prove CLI inspection survives registry reload",
          ownerSessionKey: "agent:main:main",
          status: "running",
          stopCondition: { kind: "manual" },
          notifyPolicy: { kind: "state_changes", onWaiting: true },
          currentStep: "inspect_registry",
          summary: "Initial run in progress",
          nextWakeAt: 500,
          backing: { taskFlowId: "flow-reload" },
          source: { kind: "chat_commitment", messageText: "I'll keep checking this." },
          requesterOrigin: { channel: "slack", to: "user:U123" },
          createdBy: "tests",
          createdAt: 400,
          updatedAt: 400,
        });
        const updated = updateDurableJobRecordByIdExpectedRevision({
          jobId: created.jobId,
          expectedRevision: created.audit.revision,
          patch: {
            status: "waiting",
            currentStep: "await_next_wake",
            summary: "Waiting after reload proof setup",
            nextWakeAt: 900,
          },
          updatedAt: 700,
        });
        if (!updated.applied) {
          throw new Error("expected durable job update to apply");
        }
        recordDurableJobTransition({
          jobId: created.jobId,
          from: "running",
          to: "waiting",
          actor: "assistant",
          reason: "Waiting for the next sweep",
          at: 701,
          disposition: {
            kind: "notify_and_schedule",
            notification: { status: "sent" },
            wake: { status: "scheduled", nextWakeAt: 900 },
          },
          revision: updated.job.audit.revision,
        });

        resetDurableJobRegistryForTests({ persist: false });

        const listRuntime = createRuntime();
        await jobsListCommand({ json: true, owner: "agent:main:main" }, listRuntime as never);
        expect(JSON.parse(listRuntime.log.mock.calls[0][0])).toEqual(
          expect.objectContaining({
            count: 1,
            owner: "agent:main:main",
            jobs: [
              expect.objectContaining({
                jobId: "job-reload",
                status: "waiting",
                currentStep: "await_next_wake",
                nextWakeAt: 900,
                backing: expect.objectContaining({ taskFlowId: "flow-reload" }),
              }),
            ],
          }),
        );

        const showRuntime = createRuntime();
        await jobsShowCommand({ jobId: "job-reload", json: true }, showRuntime as never);
        expect(JSON.parse(showRuntime.log.mock.calls[0][0])).toEqual(
          expect.objectContaining({
            jobId: "job-reload",
            status: "waiting",
            history: [
              expect.objectContaining({
                from: "running",
                to: "waiting",
                reason: "Waiting for the next sweep",
                revision: 1,
                disposition: expect.objectContaining({
                  notification: expect.objectContaining({ status: "sent" }),
                  wake: expect.objectContaining({ status: "scheduled", nextWakeAt: 900 }),
                }),
              }),
            ],
          }),
        );
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });

  it("returns a clear not-found error for unknown jobs", async () => {
    const runtime = createRuntime();
    await jobsShowCommand({ jobId: "missing-job" }, runtime as never);

    expect(runtime.error).toHaveBeenCalledWith("Durable job not found: missing-job");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
