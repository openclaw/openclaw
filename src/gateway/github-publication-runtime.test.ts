import { afterEach, describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../infra/database-engine/mixed-agent.conformance.test-support.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { repositoryRow } from "../state/github-publication.worker.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as publicationStore from "./github-publication-store-async.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  insertRepositoryGitHubPublicationFixture,
  readRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  WORKSPACE_TREE,
  createTestGitHubPublicationRuntime,
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  seedLocalPublication,
} from "./github-publication.test-support.js";
import { insertSharedWorktreeReceipt } from "./github-shared-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

function createRecoveryRuntime(warn = vi.fn()) {
  return createTestGitHubPublicationRuntime({
    placements: withEngineStoreAdmission(() =>
      createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    ),
    loadSessionRuntime: async () => {
      throw new Error("transcript reporting unavailable");
    },
    warn,
  });
}

function createRuntime() {
  const runtime = createRecoveryRuntime();
  const recovery = vi.spyOn(runtime.coordinator, "deferOrphanedRequestsAsync").mockResolvedValue();
  vi.spyOn(runtime.coordinator, "resumeSessionRequests").mockResolvedValue();
  const reports = vi.spyOn(runtime.coordinator, "listUnreportedResultsAsync").mockResolvedValue([]);
  return { runtime, recovery, reports };
}

function installPublicationRecoveryTests(engine: "sqlite" | "postgres") {
  useMixedAgentPair(engine, engine);
  installGitHubPublicationTestHarness();
  afterEach(() => vi.restoreAllMocks());

  it("backs off an unconfirmed publication after base materialization fails", async () => {
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction((database) =>
        seedLocalPublication(database, {
          requestId: "base-fetch-unconfirmed",
          status: "publishing",
        }),
      ),
    );
    const transport = githubPublicationTestMocks().runCommand;
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (argv: string[], ...args: unknown[]) =>
      argv.includes("fetch")
        ? {
            ...commandResult("", 1),
            stderr: Buffer.from(
              "fatal: Could not resolve host: https://fixture-token@example.test/repo",
            ),
          }
        : original(argv, ...args),
    );
    const warn = vi.fn();
    const runtime = createRecoveryRuntime(warn);
    for (let tick = 0; tick < 8; tick++) {
      await runtime.reconcilePublications();
    }
    const calls = transport.mock.calls.map(([argv]) => argv as string[]);
    expect(calls.filter((argv) => argv.includes("push") || argv.includes("POST"))).toEqual([]);
    expect(await runtime.coordinator.readAsync("base-fetch-unconfirmed")).toMatchObject({
      status: "publishing",
      message: expect.stringContaining("fatal: Could not resolve host"),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("fatal: Could not resolve host");
    expect(
      JSON.stringify(await runtime.coordinator.readAsync("base-fetch-unconfirmed")),
    ).not.toContain("fixture-token");
    expect(warn.mock.calls[0]?.[0]).not.toContain("fixture-token");
    expect(calls.filter((argv) => argv.includes("fetch"))).toHaveLength(1);

    let attempts = 1;
    for (const waitMs of [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
      now += waitMs - 1;
      await runtime.reconcilePublications();
      expect(warn).toHaveBeenCalledTimes(attempts);
      now++;
      await runtime.reconcilePublications();
      expect(warn).toHaveBeenCalledTimes(++attempts);
      expect(warn.mock.calls.at(-1)?.[0]).toContain("fatal: Could not resolve host");
    }
    expect(transport.mock.calls.filter(([argv]) => argv.includes("fetch"))).toHaveLength(8);
    expect(
      transport.mock.calls.filter(([argv]) => argv.includes("push") || argv.includes("POST")),
    ).toEqual([]);

    // A restart deliberately resets this interim scheduling policy, not the accepted receipt.
    await runtime.close();
    const restarted = createRecoveryRuntime(warn);
    await restarted.reconcilePublications();
    expect(warn).toHaveBeenCalledTimes(9);
    expect(await restarted.coordinator.readAsync("base-fetch-unconfirmed")).toMatchObject({
      status: "publishing",
    });
  });

  it("recovers the original publication after a transient fetch failure without another push or PR", async () => {
    const requestId = "transient-fetch";
    withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction((database) =>
        seedLocalPublication(database, { requestId, status: "publishing" }),
      ),
    );
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let unavailable = true;
    const transport = githubPublicationTestMocks().runCommand;
    const original = transport.getMockImplementation()!;
    const url = "https://github.com/openclaw/openclaw/pull/125200";
    transport.mockImplementation(async (argv: string[], ...args: unknown[]) => {
      if (argv.includes("fetch") && unavailable) {
        return commandResult("", 1);
      }
      if (argv.includes("--format=%H%n%T%n%P%n%B")) {
        return commandResult(
          `${NEW_HEAD}\n${WORKSPACE_TREE}\n${OLD_HEAD}\nResume the publication\n\nCo-authored-by: alice <7+alice@users.noreply.github.com>\nOpenClaw-Publication: ${requestId}\n`,
        );
      }
      if (argv.includes("ls-remote")) {
        return commandResult(`${NEW_HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (argv.includes("state=all")) {
        return commandResult(
          JSON.stringify([
            {
              url,
              userId: 42,
              state: "open",
              body: `<!-- openclaw-publication:${requestId} -->`,
              headSha: NEW_HEAD,
              headRef: BRANCH,
              baseRef: "main",
            },
          ]),
        );
      }
      return original(argv, ...args);
    });
    const runtime = createRecoveryRuntime();
    await runtime.reconcilePublications();
    unavailable = false;
    await runtime.reconcilePublications();
    expect(await runtime.coordinator.readAsync(requestId)).toMatchObject({
      status: "publishing",
    });
    now += 60_000;
    await runtime.reconcilePublications();
    expect(await runtime.coordinator.readAsync(requestId)).toMatchObject({
      requestId,
      status: "published",
      url,
      headCommit: NEW_HEAD,
    });
    now += 3_600_000;
    await runtime.reconcilePublications();
    expect(transport.mock.calls.filter(([argv]) => argv.includes("fetch"))).toHaveLength(2);
    expect(
      transport.mock.calls.filter(([argv]) => argv.includes("push") || argv.includes("POST")),
    ).toEqual([]);
  });

  it("reads each pending queue once during empty startup and still reads unreported results", async () => {
    const runtime = createRecoveryRuntime();
    const repositoryReads = vi.spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync");
    const sharedReads = vi.spyOn(publicationStore, "listSharedGitHubPublicationsAsync");
    await runtime.reconcilePublications();
    expect(repositoryReads.mock.calls.map(([input]) => input)).toEqual([
      { ownerProfileId: null, pending: true },
      { pending: false, unreported: true },
    ]);
    expect(sharedReads.mock.calls.map(([input]) => input)).toEqual([
      { pending: true },
      { pending: false, unreported: true },
    ]);
  });

  it.each(
    (["repository", "shared"] as const).flatMap((kind) =>
      (["load", "defer", "resume"] as const).flatMap((boundary) =>
        (["insert", "unknown"] as const).map((change) => [kind, boundary, change] as const),
      ),
    ),
  )("invalidates %s emptiness after %s receives %s", async (kind, boundary, change) => {
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
        if (kind === "shared") {
          withEngineStoreAdmission(() => insertSharedWorktreeReceipt("startup-insert"));
        } else {
          withEngineStoreAdmission(() =>
            insertRepositoryGitHubPublicationFixture(repositoryRow("startup-insert"), () => {}),
          );
        }
      } else {
        notify(
          {
            kind: "unknown",
            identity: captureOpenClawStateWorkerContext().admission.identity.key,
          },
          false,
        );
      }
    };
    const listRepository = publicationStore.listRepositoryGitHubPublicationsAsync;
    const repositoryReads = vi
      .spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync")
      .mockImplementation(async (input) => {
        const rows = await listRepository(input);
        if (kind === "repository" && boundary === "load") {
          invalidate();
        }
        return rows;
      });
    const listShared = publicationStore.listSharedGitHubPublicationsAsync;
    const sharedReads = vi
      .spyOn(publicationStore, "listSharedGitHubPublicationsAsync")
      .mockImplementation(async (input) => {
        const rows = await listShared(input);
        if (kind === "shared" && boundary === "load" && input?.pending && !input.claimNull) {
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
    const resume = runtime.coordinator.resumeSessionRequests.bind(runtime.coordinator);
    vi.spyOn(runtime.coordinator, "resumeSessionRequests").mockImplementation(async (...args) => {
      if (boundary === "resume") {
        await Promise.resolve();
        invalidate();
      }
      return resume(...args);
    });

    await runtime.reconcilePublications();
    expect(changed).toBe(true);
    if (kind === "repository") {
      expect(repositoryReads).toHaveBeenCalledTimes(boundary === "resume" ? 3 : 4);
    } else {
      expect(sharedReads.mock.calls.map(([input]) => input)).toEqual([
        { pending: true },
        { claimNull: true, pending: true },
        { pending: false, unreported: true },
      ]);
    }
    if (change === "insert") {
      if (kind === "repository") {
        // The real recovery path retires the receipt whose synthetic workspace no longer exists.
        expect(
          withEngineStoreAdmission(() => readRepositoryGitHubPublicationFixture("startup-insert"))
            ?.status,
        ).toBe("failed");
      } else {
        // Recovery settles the receipt even though the synthetic checkout cannot publish.
        expect(await runtime.coordinator.readAsync("startup-insert")).toMatchObject({
          status: "failed",
        });
      }
    } else {
      const reads = kind === "shared" ? sharedReads : repositoryReads;
      const previousReads = reads.mock.calls.length;
      await runtime.reconcilePublications();
      const pending =
        kind === "shared" ? { pending: true } : { ownerProfileId: null, pending: true };
      expect(reads.mock.calls.slice(previousReads).map(([input]) => input)).toEqual(
        boundary === "load" ? [pending] : [pending, { pending: false, unreported: true }],
      );
    }
  });

  it("keeps fresh recovery reads for a nonempty startup snapshot", async () => {
    withEngineStoreAdmission(() =>
      insertRepositoryGitHubPublicationFixture(repositoryRow("startup-existing"), () => {}),
    );
    const runtime = createRecoveryRuntime();
    const reads = vi.spyOn(publicationStore, "listRepositoryGitHubPublicationsAsync");
    await runtime.reconcilePublications();
    expect(reads).toHaveBeenCalledTimes(4);
    expect(
      withEngineStoreAdmission(() => readRepositoryGitHubPublicationFixture("startup-existing"))
        ?.status,
    ).toBe("failed");
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

    withEngineStoreAdmission(() => insertSharedWorktreeReceipt("idle-recovery-request"));
    await runtime.reconcilePublications();
    await runtime.reconcilePublications();
    expect(recovery).toHaveBeenCalledTimes(3);

    const claimed = withEngineStoreAdmission(() =>
      claimGitHubPublicationExecutionFixture("idle-recovery-request", "instance"),
    );
    withEngineStoreAdmission(() =>
      createGitHubPublicationExecutionStoreFixture("instance").complete(claimed, {
        requestId: claimed.request_id,
        status: "failed",
        code: "unavailable",
        message: "Publication unavailable",
        nextAction: "Retry publication",
      }),
    );
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
    withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction((database) =>
        seedLocalPublication(database, {
          requestId: "pending-before-runtime",
          status: "requested",
        }),
      ),
    );
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
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} GitHub publication idle recovery`,
    () => installPublicationRecoveryTests(engine),
  );
}
