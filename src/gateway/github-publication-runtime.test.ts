import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
} from "./github-publication-store.test-support.js";
import {
  createTestGitHubPublicationRuntime,
  installGitHubPublicationTestHarness,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

installGitHubPublicationTestHarness();

function createRuntime() {
  const runtime = createTestGitHubPublicationRuntime({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    loadSessionRuntime: async () => {
      throw new Error("transcript reporting unavailable");
    },
    warn: vi.fn(),
  });
  const recovery = vi.spyOn(runtime.coordinator, "deferOrphanedRequestsAsync").mockResolvedValue();
  vi.spyOn(runtime.coordinator, "resumeSessionRequests").mockResolvedValue();
  const reports = vi.spyOn(runtime.coordinator, "listUnreportedResultsAsync").mockResolvedValue([]);
  return { runtime, recovery, reports };
}

describe("GitHub publication idle recovery", () => {
  it("sleeps after an empty scan and follows committed inserts through reporting", async () => {
    const { runtime, recovery } = createRuntime();
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(1);

    insertSharedWorktreeReceipt("idle-recovery-request");
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(3);

    const claimed = claimGitHubPublicationExecutionFixture("idle-recovery-request", "instance");
    createGitHubPublicationExecutionStoreFixture("instance").complete(claimed, {
      requestId: claimed.request_id,
      status: "failed",
      code: "unavailable",
      message: "Publication unavailable",
      nextAction: "Retry publication",
    });
    // Unreported terminal outcomes still need recovery even after execution ends.
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(5);

    await runtime.coordinator.markReportedAsync(claimed.request_id);
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(6);
  });

  it("loads pending requests from before the runtime subscribed", async () => {
    seedLocalPublication(openOpenClawStateDatabase(), {
      requestId: "pending-before-runtime",
      status: "requested",
    });
    const { runtime, recovery } = createRuntime();
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(2);
  });

  it("retries an unreported startup result after transcript reporting fails", async () => {
    const { runtime, recovery, reports } = createRuntime();
    reports.mockResolvedValueOnce([
      {
        sessionId: "failed-report-session",
        sessionKey: "agent:main:failed-report",
        agentId: "main",
        result: {
          requestId: "failed-report-request",
          status: "failed",
          code: "unavailable",
          message: "Publication unavailable",
          nextAction: "Retry publication",
        },
      },
    ]);
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(2);
  });
});
