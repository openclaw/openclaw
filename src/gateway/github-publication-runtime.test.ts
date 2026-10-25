import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { repositoryRow } from "../state/github-publication.worker.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as publicationStore from "./github-publication-store-async.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  insertRepositoryGitHubPublicationFixture,
  readRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import {
  createTestGitHubPublicationRuntime,
  installGitHubPublicationTestHarness,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

installGitHubPublicationTestHarness();
afterEach(() => vi.restoreAllMocks());

function createRecoveryRuntime() {
  return createTestGitHubPublicationRuntime({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    loadSessionRuntime: async () => {
      throw new Error("transcript reporting unavailable");
    },
    warn: vi.fn(),
  });
}

function createRuntime() {
  const runtime = createRecoveryRuntime();
  const recovery = vi.spyOn(runtime.coordinator, "deferOrphanedRequestsAsync").mockResolvedValue();
  vi.spyOn(runtime.coordinator, "resumeSessionRequests").mockResolvedValue();
  const reports = vi.spyOn(runtime.coordinator, "listUnreportedResultsAsync").mockResolvedValue([]);
  return { runtime, recovery, reports };
}

describe("GitHub publication idle recovery", () => {
  it("reads pending repository requests once during empty startup and still reads unreported results", async () => {
    const runtime = createRecoveryRuntime();
    const repositoryReads = vi.spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync");
    await runtime.reconcilePublications();
    expect(repositoryReads.mock.calls.map(([input]) => input)).toEqual([
      { ownerProfileId: null, pending: true },
      { pending: false, unreported: true },
    ]);
  });

  it.each([
    ["load", "insert"],
    ["defer", "insert"],
    ["resume", "insert"],
    ["load", "unknown"],
    ["defer", "unknown"],
    ["resume", "unknown"],
  ] as const)("invalidates the empty fact after %s receives %s", async (boundary, change) => {
    let notify: Parameters<typeof githubPublicationReceipts.subscribeFacts>[0] = () => {
      throw new Error("runtime did not subscribe");
    };
    const subscribe = githubPublicationReceipts.subscribeFacts;
    vi.spyOn(githubPublicationReceipts, "subscribeFacts").mockImplementation((listener) => {
      notify = listener;
      return subscribe(listener);
    });
    const runtime = createRecoveryRuntime();
    let changed = false;
    const invalidate = () => {
      if (changed) {
        return;
      }
      changed = true;
      if (change === "insert") {
        insertRepositoryGitHubPublicationFixture(repositoryRow("startup-insert"), () => {});
      } else {
        notify(
          { kind: "unknown", identity: captureOpenClawStateWorkerContext().admission.identity.key },
          false,
        );
      }
    };
    const listRepository = publicationStore.listRepositoryGitHubPublicationsAsync;
    const reads = vi
      .spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync")
      .mockImplementation(async (input) => {
        const rows = await listRepository(input);
        if (boundary === "load") {
          invalidate();
        }
        return rows;
      });
    const defer = publicationStore.deferGitHubPublicationRequestsAsync;
    vi.spyOn(publicationStore, "deferGitHubPublicationRequestsAsync").mockImplementation(
      async (...args) => {
        await defer(...args);
        if (boundary === "defer") {
          invalidate();
        }
      },
    );
    const listShared = publicationStore.listSharedGitHubPublicationsAsync;
    vi.spyOn(publicationStore, "listSharedGitHubPublicationsAsync").mockImplementation(
      async (input) => {
        const rows = await listShared(input);
        if (boundary === "resume" && input?.claimNull) {
          invalidate();
        }
        return rows;
      },
    );

    await runtime.reconcilePublications();
    expect(changed).toBe(true);
    expect(reads).toHaveBeenCalledTimes(boundary === "resume" ? 3 : 4);
    if (change === "insert") {
      // The real recovery path retires the receipt whose synthetic workspace no longer exists.
      expect(readRepositoryGitHubPublicationFixture("startup-insert")?.status).toBe("failed");
    } else {
      const previousReads = reads.mock.calls.length;
      await runtime.reconcilePublications();
      expect(reads.mock.calls.slice(previousReads).map(([input]) => input)).toEqual(
        boundary === "load"
          ? [{ ownerProfileId: null, pending: true }]
          : [
              { ownerProfileId: null, pending: true },
              { pending: false, unreported: true },
            ],
      );
    }
  });

  it("keeps fresh recovery reads for a nonempty startup snapshot", async () => {
    insertRepositoryGitHubPublicationFixture(repositoryRow("startup-existing"), () => {});
    const runtime = createRecoveryRuntime();
    const reads = vi.spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync");
    await runtime.reconcilePublications();
    expect(reads).toHaveBeenCalledTimes(4);
    expect(readRepositoryGitHubPublicationFixture("startup-existing")?.status).toBe("failed");
  });

  it.each(["stop", "failure"] as const)(
    "does not carry an empty fact past an invocation ending in %s",
    async (ending) => {
      const runtime = createRecoveryRuntime();
      const reads = vi.spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync");
      let stopped = false;
      const defer = publicationStore.deferGitHubPublicationRequestsAsync;
      vi.spyOn(publicationStore, "deferGitHubPublicationRequestsAsync").mockImplementationOnce(
        async (...args) => {
          await defer(...args);
          if (ending === "failure") {
            throw new Error("synthetic recovery failure");
          }
          stopped = true;
        },
      );
      await runtime.reconcilePublications(() => stopped);
      const previousReads = reads.mock.calls.length;
      await runtime.reconcilePublications();
      expect(reads).toHaveBeenCalledTimes(previousReads + 3);
    },
  );

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
