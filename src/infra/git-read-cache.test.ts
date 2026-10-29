import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureSessionDiffBaseline, loadCheckoutDiff } from "../sessions/session-diff.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import { runGitReadOperation } from "./git-read-cache.js";
import type { GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";

vi.mock("./git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

const gitRead = vi.fn<typeof runGitWorkerOperation>();
const readRevision = vi.fn<() => Promise<GitReadOperations["checkout.revision"]["output"]>>();

beforeEach(() => {
  readRevision.mockResolvedValue({ key: "unchanged" });
  vi.mocked(runGitWorkerOperation).mockImplementation((operation, options) =>
    operation.type === "checkout.revision"
      ? readRevision()
      : operation.type === "pull-request.branch-comparison"
        ? Promise.resolve({
            statsBase: null,
            creatable: false,
            equalPushedTips: false,
            complete: true,
          })
        : gitRead(operation, options),
  );
});

afterEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  gitRead.mockReset();
  readRevision.mockReset();
  vi.useRealTimers();
});

const emptyDiff = { files: [], additions: 0, deletions: 0 };

function holdRead<K extends keyof GitReadOperations>(
  _type: K,
  fallback: GitReadOperations[K]["output"],
) {
  const held = createDeferredCore<GitReadOperations[K]["output"]>();
  onTestFinished(() => held.resolve(fallback));
  gitRead.mockReturnValueOnce(held.promise);
  return held;
}

function identity(root: string, fingerprint: string, originUrl = "") {
  return { checkoutRoot: root, repoRoot: root, originUrl, fingerprint };
}

function contextRead(root: string) {
  return { type: "checkout.context" as const, input: { root } };
}

function workerCalls(type: keyof GitReadOperations) {
  return vi.mocked(runGitWorkerOperation).mock.calls.filter(([command]) => command.type === type);
}

function collectCheckoutDiffPhases() {
  const events: DiagnosticEventPayload[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event), {
    includeTrusted: ["diagnostic.phase.completed"],
  });
  onTestFinished(stop);
  return () =>
    events
      .filter((event) => event.type === "diagnostic.phase.completed")
      .filter((event) => event.name === "checkout.diff");
}

describe("typed Git read ownership", () => {
  it("retains interleaved PR histories while sharing checks of the same checkout refs", async () => {
    const read = (sha: string, branch = "feature", refreshIndex = false) =>
      runGitReadOperation({
        type: "pull-request.branch-facts",
        input: {
          root: "/shared-pr-histories",
          branch,
          defaultBranch: "main",
          mergedHeads: [{ sha }],
          refreshIndex,
        },
      });
    gitRead.mockImplementation(async (operation) => {
      if (operation.type !== "pull-request.branch-facts") {
        throw new Error("Unexpected Git read");
      }
      return { creatable: operation.input.mergedHeads[0]?.sha === "a", stats: null };
    });
    const expected = [
      { creatable: true, stats: null },
      { creatable: false, stats: null },
    ];
    expect(await Promise.all([read("a"), read("b")])).toEqual(expected);
    // One worktree check and one refs check, independent of each session's PR receipts.
    expect(readRevision).toHaveBeenCalledTimes(2);
    expect(gitRead).toHaveBeenCalledTimes(2);
    expect(await read("a")).toEqual(expected[0]);
    expect(await read("b")).toEqual(expected[1]);
    expect(gitRead).toHaveBeenCalledTimes(2);

    // The result includes branch and index-refresh policy; neither may cross slots.
    await read("a", "other");
    await read("a", "feature", true);
    expect(gitRead).toHaveBeenCalledTimes(4);
    readRevision.mockResolvedValue({ key: "refs-or-index-changed" });
    expect(await Promise.all([read("a"), read("b")])).toEqual(expected);
    expect(gitRead).toHaveBeenCalledTimes(6);
  });

  it("reports validation for cache hits and shared misses without replaying cached Git work", async () => {
    const readPhases = collectCheckoutDiffPhases();
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation, options) => {
      if (options?.diffTiming) {
        options.diffTiming.durations["worker-queue"] =
          operation.type === "checkout.revision" ? 2 : 5;
        options.diffTiming.durations["git-wall"] = operation.type === "checkout.revision" ? 0 : 10;
      }
      return operation.type === "checkout.revision" ? { key: "unchanged" } : emptyDiff;
    });
    const operation = {
      type: "checkout.diff" as const,
      input: { cwd: "/timing-private", summaryOnly: true },
    };
    await Promise.all([runGitReadOperation(operation), runGitReadOperation(operation)]);
    await runGitReadOperation(operation);
    await waitForDiagnosticEventsDrained();
    const phases = readPhases();
    expect(phases).toHaveLength(3);
    expect(phases.map((event) => event.details?.outcome)).toEqual([
      "cache-miss",
      "cache-miss",
      "cache-hit",
    ]);
    expect(phases.map((event) => event.details?.["worker-queue"])).toEqual([7, 7, 2]);
    expect(phases.map((event) => event.details?.["git-wall"])).toEqual([10, 10, 0]);
    expect(phases.map((event) => event.details?.missReason)).toEqual([
      "cold",
      "pending",
      undefined,
    ]);
    expect(phases.every((event) => typeof event.details?.["cache-validate"] === "number")).toBe(
      true,
    );
    expect(JSON.stringify(phases)).not.toContain("timing-private");
  });

  it("reports bounded revision components while retaining independent request shapes", async () => {
    const readPhases = collectCheckoutDiffPhases();
    gitRead.mockResolvedValue(emptyDiff);
    const unchanged = {
      head: "private-head",
      index: "private-index",
      untrackedSet: "private-paths",
      worktreeMtime: "private-files",
      metadata: "private-config",
    };
    for (const component of [
      "head",
      "index",
      "untrackedSet",
      "worktreeMtime",
      "metadata",
    ] as const) {
      const input = { cwd: `/revision-reasons-${component}`, summaryOnly: true };
      const read = (baseCommit?: string) =>
        runGitReadOperation({ type: "checkout.diff", input: { ...input, baseCommit } });
      readRevision.mockResolvedValue({ key: JSON.stringify(unchanged) });
      await read();
      await read("a".repeat(40));
      await read();
      readRevision.mockResolvedValue({
        key: JSON.stringify({ ...unchanged, [component]: "private-changed" }),
      });
      await read();
      await read("a".repeat(40));
      await read();
    }
    await waitForDiagnosticEventsDrained();
    const phases = readPhases();
    expect(phases.map((event) => event.details?.missReason)).toEqual(
      ["head", "index", "untracked-set", "worktree-mtime", "metadata"].flatMap((component) => [
        "cold",
        "cold",
        undefined,
        `revision-changed-${component}`,
        `revision-changed-${component}`,
        undefined,
      ]),
    );
    expect(gitRead).toHaveBeenCalledTimes(20);
    expect(JSON.stringify(phases)).not.toContain("private");
  });

  it("distinguishes unavailable revisions and bounded capacity eviction history", async () => {
    const readPhases = collectCheckoutDiffPhases();
    const read = (cwd: string) => runGitReadOperation({ type: "checkout.diff", input: { cwd } });
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation, options) => {
      if (operation.type !== "checkout.revision") {
        return emptyDiff;
      }
      if (operation.input.root === "/reason-oversized" && options?.diffTiming) {
        options.diffTiming.revisionUnavailableReason = "oversized";
      }
      return operation.input.root.startsWith("/reason-") ? null : { key: "unchanged" };
    });
    await read("/reason-unavailable");
    await read("/reason-oversized");
    for (let i = 0; i < 65; i++) {
      await read(`/bounded-eviction-${i}`);
    }
    await read("/bounded-eviction-0");
    await read("/bounded-eviction-2");
    await waitForDiagnosticEventsDrained();
    const phases = readPhases();
    const reasons = phases.map((event) => event.details?.missReason);
    expect(reasons.slice(0, 2)).toEqual(["no-revision", "oversized"]);
    expect(reasons.slice(-2)).toEqual(["cold", "evicted"]);
  });

  it("serves identity snapshots while one background pass refreshes external metadata", async () => {
    vi.useFakeTimers();
    const cold = holdRead("repository.identities", []);
    const operation = { type: "repository.identities" as const, input: { roots: ["/snapshot"] } };
    await expect(runGitReadOperation(operation)).resolves.toEqual([]);
    vi.advanceTimersByTime(120_000);
    await expect(runGitReadOperation(operation)).resolves.toEqual([]);
    expect(gitRead).toHaveBeenCalledOnce();
    const changed = { ...operation, input: { roots: ["/new-checkout-set"] } };
    const changedIdentity = identity("/new-checkout-set", "new");
    gitRead.mockResolvedValueOnce([changedIdentity]);
    await expect(runGitReadOperation(changed)).resolves.toEqual([]);
    expect(gitRead).toHaveBeenCalledOnce();
    const snapshot = identity("/snapshot", "old", "https://example.test/old.git");
    cold.resolve([snapshot]);
    await cold.promise;
    await vi.advanceTimersByTimeAsync(0);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    await expect(runGitReadOperation(changed)).resolves.toEqual([changedIdentity]);
    const refresh = holdRead("repository.identities", []);
    vi.advanceTimersByTime(60_001);
    const stale = await runGitReadOperation(operation);
    await vi.advanceTimersByTimeAsync(0);
    expect(stale).toEqual([snapshot]);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    expect(gitRead).toHaveBeenCalledTimes(3);
    refresh.resolve([]);
    await refresh.promise;
    await vi.advanceTimersByTimeAsync(0);
    await expect(runGitReadOperation(operation)).resolves.toEqual([]);
  });

  it("retains failed identity snapshots and joins background cancellation on shutdown", async () => {
    vi.useFakeTimers();
    const operation = {
      type: "repository.identities" as const,
      input: { roots: ["/snapshot-lifetime"] },
    };
    const snapshot = identity("/snapshot-lifetime", "retained");
    gitRead.mockResolvedValueOnce([snapshot]);
    await runGitReadOperation(operation);
    await vi.advanceTimersByTimeAsync(0);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    gitRead.mockRejectedValueOnce(new Error("temporary discovery failure"));
    vi.advanceTimersByTime(60_001);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    expect(gitRead).toHaveBeenCalledTimes(2);
    const held = holdRead("repository.identities", []);
    vi.advanceTimersByTime(60_001);
    await expect(runGitReadOperation(operation)).resolves.toEqual([snapshot]);
    await vi.advanceTimersByTimeAsync(0);
    const owner = gitRead.mock.calls.at(-1)?.[1]?.signal;
    const retiring = drainGlobalSingletonLifecycleState("restart");
    await Promise.resolve();
    expect(owner?.aborted).toBe(true);
    await expect(runGitReadOperation(operation)).rejects.toThrow("restarting");
    held.resolve([snapshot]);
    await retiring;
    gitRead.mockResolvedValueOnce([]);
    await expect(runGitReadOperation(operation)).resolves.toEqual([]);
  });

  it("shares concurrent checkout work without sharing session envelopes or settled file state", async () => {
    readRevision.mockResolvedValue(null);
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    gitRead.mockReturnValueOnce(held.promise);
    const first = loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-a" });
    const second = loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-b" });
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledOnce());
    held.resolve(emptyDiff);
    await expect(first).resolves.toEqual({ ...emptyDiff, sessionKey: "session-a" });
    await expect(second).resolves.toEqual({ ...emptyDiff, sessionKey: "session-b" });
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 3 });
    await expect(
      loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-a" }),
    ).resolves.toMatchObject({ additions: 3 });
    expect(gitRead).toHaveBeenCalledTimes(2);
  });

  it("shares summary work until expiry without duplicating a slow scan or reusing full patches", async () => {
    vi.useFakeTimers();
    vi.mocked(runGitWorkerOperation).mockImplementation((operation, options) =>
      operation.type === "checkout.revision"
        ? Promise.resolve(operation.input.summaryOnly ? null : { key: "unchanged-full-diff" })
        : gitRead(operation, options),
    );
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    gitRead.mockReturnValueOnce(held.promise);
    const input = { cwd: "/summary-sharing", summaryOnly: true };
    const first = loadCheckoutDiff({ ...input, sessionKey: "first" });
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(15_000);
    const second = loadCheckoutDiff({ ...input, sessionKey: "second" });
    // Admit the second viewer through its async revision check before settling the scan.
    await vi.advanceTimersByTimeAsync(0);
    expect(gitRead).toHaveBeenCalledOnce();
    held.resolve({ ...emptyDiff, additions: 2 });
    await expect(first).resolves.toMatchObject({ sessionKey: "first", additions: 2 });
    await expect(second).resolves.toMatchObject({ sessionKey: "second", additions: 2 });
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 3 });
    await expect(loadCheckoutDiff({ ...input, sessionKey: "first" })).resolves.toMatchObject({
      additions: 3,
    });
    const workBeforeRetainedRead = vi.mocked(runGitWorkerOperation).mock.calls.length;
    await expect(loadCheckoutDiff({ ...input, sessionKey: "second" })).resolves.toMatchObject({
      additions: 3,
    });
    expect(vi.mocked(runGitWorkerOperation).mock.calls.length).toBe(workBeforeRetainedRead);
    expect(gitRead).toHaveBeenCalledTimes(2);
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 4 });
    await expect(loadCheckoutDiff({ cwd: input.cwd, sessionKey: "first" })).resolves.toMatchObject({
      additions: 4,
    });
    expect(gitRead).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10_001);
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 5 });
    await expect(loadCheckoutDiff({ ...input, sessionKey: "first" })).resolves.toMatchObject({
      additions: 5,
    });
    expect(gitRead).toHaveBeenCalledTimes(4);
    await expect(loadCheckoutDiff({ cwd: input.cwd, sessionKey: "first" })).resolves.toMatchObject({
      additions: 4,
    });
    expect(gitRead).toHaveBeenCalledTimes(4);
  });

  it("retains unchanged checkout diffs by revision and complete request shape", async () => {
    vi.useFakeTimers();
    const input = { cwd: "/versioned-diff" };
    const summary = { ...input, summaryOnly: true };
    const changedBase = { ...input, baseCommit: "a".repeat(40) };
    const changedSession = { ...input, sessionId: "another-session" };
    gitRead.mockResolvedValue({ ...emptyDiff, additions: 2 });
    const read = (params: typeof input) =>
      runGitReadOperation({ type: "checkout.diff", input: params });
    for (const params of [input, summary, changedBase, changedSession]) {
      await read(params);
    }
    expect(gitRead).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(120_000);
    for (const params of [summary, changedSession, input, changedBase]) {
      await read(params);
    }
    expect(gitRead).toHaveBeenCalledTimes(4);
    readRevision.mockResolvedValue({ key: "edited-checkout" });
    await expect(read(summary)).resolves.toMatchObject({ additions: 2 });
    await expect(read(input)).resolves.toMatchObject({ additions: 2 });
    expect(gitRead).toHaveBeenCalledTimes(6);
    await read(summary);
    await read(input);
    expect(gitRead).toHaveBeenCalledTimes(6);
    await drainGlobalSingletonLifecycleState("restart");
    await read(input);
    expect(gitRead).toHaveBeenCalledTimes(7);
    readRevision.mockResolvedValue({ key: "retryable-checkout" });
    gitRead.mockResolvedValueOnce({ ...emptyDiff, unavailableReason: "not_git" });
    await read(input);
    await expect(read(input)).resolves.toMatchObject({ unavailableReason: "not_git" });
    vi.advanceTimersByTime(1_001);
    await expect(read(input)).resolves.toMatchObject({ additions: 2 });
    expect(gitRead).toHaveBeenCalledTimes(9);
  });

  it("polls one cold checkout without waiting for revision work or losing unversioned results", async () => {
    vi.useFakeTimers();
    const revision = createDeferredCore<GitReadOperations["checkout.revision"]["output"]>();
    readRevision.mockReturnValue(revision.promise);
    gitRead.mockResolvedValue({ ...emptyDiff, additions: 7 });
    const input = { cwd: "/poll-cold-checkout", sessionId: "first" };
    const poll = (sessionId = input.sessionId) =>
      runGitReadOperation(
        { type: "checkout.diff", input: { ...input, sessionId } },
        { poll: true },
      );
    const responses: unknown[] = [];
    const requests = [poll(), poll(), poll("second")];
    for (const request of requests) {
      void request.then((result) => responses.push(result));
    }
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(responses).toEqual(
        Array.from({ length: 3 }, () => ({ ...emptyDiff, computing: true })),
      );
      expect(readRevision).toHaveBeenCalledOnce();
      expect(gitRead).not.toHaveBeenCalled();
      revision.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(gitRead).toHaveBeenCalledTimes(2);
      await runGitReadOperation({ type: "checkout.diff", input });
      expect(gitRead).toHaveBeenCalledTimes(3);
      await expect(poll()).resolves.toMatchObject({ additions: 7 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(poll()).resolves.toMatchObject({ additions: 7 });
      await expect(poll("second")).resolves.toMatchObject({ additions: 7 });
      expect(gitRead).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(501);
      await expect(poll()).resolves.toMatchObject({ additions: 7 });
      expect(gitRead).toHaveBeenCalledTimes(4);
    } finally {
      revision.resolve(null);
      await Promise.allSettled(requests);
    }
  });

  it("delivers a shared pending diff that settles within each viewer's wait budget", async () => {
    vi.useFakeTimers();
    const held = holdRead("checkout.diff", emptyDiff);
    const poll = () =>
      runGitReadOperation(
        { type: "checkout.diff", input: { cwd: "/poll-shared-budget" } },
        { poll: true },
      );
    const first = poll();
    await vi.advanceTimersByTimeAsync(500);
    const second = poll();
    await vi.advanceTimersByTimeAsync(500);
    held.resolve({ ...emptyDiff, additions: 7 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ...emptyDiff, additions: 7 },
      { ...emptyDiff, additions: 7 },
    ]);
    expect(gitRead).toHaveBeenCalledOnce();
  });

  it("keeps warm polls on the freshness path beyond the cold wait budget", async () => {
    vi.useFakeTimers();
    const readPhases = collectCheckoutDiffPhases();
    const poll = () =>
      runGitReadOperation(
        { type: "checkout.diff", input: { cwd: "/poll-warm-freshness" } },
        { poll: true },
      );
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 1 });
    await expect(poll()).resolves.toMatchObject({ additions: 1 });
    await vi.advanceTimersByTimeAsync(1_001);
    const revision = createDeferredCore<GitReadOperations["checkout.revision"]["output"]>();
    readRevision.mockReturnValue(revision.promise);
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 2 });
    const responses: unknown[] = [];
    const requests = [poll(), poll()];
    for (const request of requests) {
      void request.then((result) => responses.push(result));
    }
    try {
      await vi.advanceTimersByTimeAsync(2_001);
      expect(responses).toEqual([]);
      revision.resolve({ key: "edited" });
      await expect(Promise.all(requests)).resolves.toEqual([
        { ...emptyDiff, additions: 2 },
        { ...emptyDiff, additions: 2 },
      ]);
      expect(gitRead).toHaveBeenCalledTimes(2);
      await vi.runAllTimersAsync();
      await waitForDiagnosticEventsDrained();
      expect(readPhases()).toHaveLength(3);
    } finally {
      revision.resolve({ key: "edited" });
      await Promise.allSettled(requests);
    }
  });

  it("bounds pending poll work, fans out its errors, and retires it with the Gateway", async () => {
    vi.useFakeTimers();
    await drainGlobalSingletonLifecycleState("restart");
    readRevision.mockResolvedValue(null);
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    const retiringRevision = createDeferredCore<GitReadOperations["checkout.revision"]["output"]>();
    gitRead.mockReturnValue(held.promise);
    const poll = (index: number) =>
      runGitReadOperation(
        { type: "checkout.diff", input: { cwd: `/poll-capacity-${index}` } },
        { poll: true },
      );
    const responses: unknown[] = [];
    const requests = Array.from({ length: 33 }, (_, index) => poll(index));
    for (const request of requests) {
      void request.then((result) => responses.push(result));
    }
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(responses).toEqual(
        Array.from({ length: 33 }, () => ({ ...emptyDiff, computing: true })),
      );
      expect(gitRead).toHaveBeenCalledTimes(32);
      held.reject(new Error("Git read failed"));
      await vi.advanceTimersByTimeAsync(0);
      await expect(poll(0)).rejects.toThrow("Git read failed");
      await expect(poll(0)).rejects.toThrow("Git read failed");
      await vi.advanceTimersByTimeAsync(1_001);
      gitRead.mockResolvedValue(emptyDiff);
      await expect(poll(32)).resolves.toEqual(emptyDiff);
      expect(gitRead).toHaveBeenCalledTimes(33);
      readRevision.mockReturnValueOnce(retiringRevision.promise);
      const retiringRead = poll(33);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(retiringRead).resolves.toEqual({ ...emptyDiff, computing: true });
      const owner = vi.mocked(runGitWorkerOperation).mock.calls.at(-1)?.[1]?.signal;
      const retiring = drainGlobalSingletonLifecycleState("restart");
      await vi.advanceTimersByTimeAsync(0);
      expect(owner?.aborted).toBe(true);
      retiringRevision.resolve(null);
      await retiring;
      await expect(poll(1)).resolves.toEqual(emptyDiff);
      expect(gitRead).toHaveBeenCalledTimes(34);
    } finally {
      held.resolve(emptyDiff);
      retiringRevision.resolve(null);
      await Promise.allSettled(requests);
    }
  });

  it("lets blocking reads reclaim expired poll slots", async () => {
    vi.useFakeTimers();
    await drainGlobalSingletonLifecycleState("restart");
    onTestFinished(() => drainGlobalSingletonLifecycleState("restart"));
    readRevision.mockResolvedValue({ key: "unchanged" });
    gitRead.mockResolvedValue(emptyDiff);
    for (let index = 0; index < 32; index++) {
      await runGitReadOperation(
        { type: "checkout.diff", input: { cwd: `/poll-expired-${index}` } },
        { poll: true },
      );
    }
    await vi.advanceTimersByTimeAsync(1_001);
    const input = { cwd: "/blocking-after-polls" };
    await runGitReadOperation({ type: "checkout.diff", input });
    await runGitReadOperation({ type: "checkout.diff", input });
    expect(gitRead).toHaveBeenCalledTimes(33);
  });

  it("shares only in-flight revision checks with identical inputs and environment", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.revision"]["output"]>();
    onTestFinished(() => held.resolve({ key: "unchanged" }));
    readRevision.mockReturnValue(held.promise);
    gitRead.mockResolvedValue(emptyDiff);
    const input = { cwd: "/revision-sharing" };
    const read = (params: GitReadOperations["checkout.diff"]["input"]) =>
      runGitReadOperation({ type: "checkout.diff", input: params });
    const first = read(input);
    const otherCheckout = read({ cwd: "/other-revision-sharing" });
    const otherBase = read({ ...input, baseCommit: "a".repeat(40) });
    const second = read(input);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/revision-sharing-config");
    const otherEnvironment = read(input);
    vi.unstubAllEnvs();
    const revisionCount = readRevision.mock.calls.length;
    held.resolve({ key: "unchanged" });
    await Promise.all([first, otherCheckout, otherBase, second, otherEnvironment]);
    expect(revisionCount).toBe(3);
    expect(gitRead).toHaveBeenCalledTimes(4);
    readRevision.mockResolvedValue({ key: "edited" });
    await read(input);
    expect(readRevision).toHaveBeenCalledTimes(4);
    expect(gitRead).toHaveBeenCalledTimes(5);
  });

  it("prepares request identity and Git environment once per warm poll while observing changes", async () => {
    vi.useFakeTimers();
    gitRead.mockResolvedValue(emptyDiff);
    const environment = process.env;
    let configPath = "/first";
    const gitConfigRead = vi.fn(() => configPath);
    const unrelatedRead = vi.fn(() => "unused");
    const sessionIdentity = vi.fn(() => "fixture");
    process.env = {
      ...environment,
      get GIT_CONFIG_GLOBAL() {
        return gitConfigRead();
      },
      get UNRELATED_DIFF_FIXTURE() {
        return unrelatedRead();
      },
    };
    try {
      const poll = () =>
        runGitReadOperation(
          {
            type: "checkout.diff",
            input: {
              cwd: "/poll-environment",
              get sessionId() {
                return sessionIdentity();
              },
            },
          },
          { poll: true },
        );
      await poll();
      await vi.advanceTimersByTimeAsync(1_001);
      gitConfigRead.mockClear();
      sessionIdentity.mockClear();
      await poll();
      expect(gitRead).toHaveBeenCalledOnce();
      expect(gitConfigRead).toHaveBeenCalledOnce();
      expect(sessionIdentity).toHaveBeenCalledOnce();
      configPath = "/second";
      await poll();
      expect(gitRead).toHaveBeenCalledTimes(2);
      expect(unrelatedRead).not.toHaveBeenCalled();
    } finally {
      process.env = environment;
    }
  });

  it("separates unavailable checkouts by environment and honors explicit refresh", async () => {
    vi.useFakeTimers();
    const operation = { type: "checkout.diff" as const, input: { cwd: "/negative-scope" } };
    gitRead.mockResolvedValue({ ...emptyDiff, unavailableReason: "not_git" });
    try {
      await runGitReadOperation(operation);
      await runGitReadOperation(operation);
      expect(gitRead).toHaveBeenCalledOnce();
      expect(readRevision).toHaveBeenCalledOnce();
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/changed-config");
      await runGitReadOperation(operation);
      expect(gitRead).toHaveBeenCalledTimes(2);
      await runGitReadOperation(operation, { refresh: true });
      expect(gitRead).toHaveBeenCalledTimes(3);
      expect(readRevision).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives each coalesced response independent files and commit metadata", async () => {
    const held = holdRead("checkout.diff", emptyDiff);
    const first = loadCheckoutDiff({ cwd: "/independent-diffs", sessionKey: "a" });
    const second = loadCheckoutDiff({ cwd: "/independent-diffs", sessionKey: "b" });
    held.resolve({
      files: [
        { path: "file.txt", status: "modified", additions: 1, deletions: 0, patch: "full patch" },
      ],
      additions: 1,
      deletions: 0,
      commits: [{ sha: "a".repeat(40), subject: "Branch commit" }],
      mergeBase: { sha: "b".repeat(40), subject: "Base commit" },
    });
    const [truncated, complete] = await Promise.all([first, second]);
    const file = truncated.files[0]!;
    delete file.patch;
    file.truncated = true;
    truncated.files.push({ path: "other.txt", status: "added", additions: 1, deletions: 0 });
    truncated.commits![0]!.subject = "Changed branch commit";
    truncated.commits!.push({ sha: "c".repeat(40), subject: "Another commit" });
    truncated.mergeBase!.subject = "Changed base commit";
    expect(complete.files).toEqual([
      { path: "file.txt", status: "modified", additions: 1, deletions: 0, patch: "full patch" },
    ]);
    expect(complete.commits).toEqual([{ sha: "a".repeat(40), subject: "Branch commit" }]);
    expect(complete.mergeBase).toEqual({ sha: "b".repeat(40), subject: "Base commit" });
    expect(gitRead).toHaveBeenCalledOnce();
  });

  it("shares baseline fingerprints while binding each captured session independently", async () => {
    const held = holdRead("checkout.baseline", undefined);
    const first = captureSessionDiffBaseline({ cwd: "/baseline-sharing", sessionId: "a" });
    const second = captureSessionDiffBaseline({ cwd: "/baseline-sharing", sessionId: "b" });
    await Promise.resolve();
    expect(gitRead).toHaveBeenCalledOnce();
    const captured = { version: 1 as const, root: "/baseline-sharing", files: [] };
    held.resolve(captured);
    await expect(first).resolves.toEqual({ ...captured, sessionId: "a" });
    await expect(second).resolves.toEqual({ ...captured, sessionId: "b" });
  });

  it("observes an unversioned refresh without an older completion replacing it", async () => {
    const old = holdRead("checkout.context", null);
    const fresh = holdRead("checkout.context", null);
    const operation = contextRead("/refresh-generation");
    readRevision.mockResolvedValue(null);
    const pending = runGitReadOperation(operation);
    const refresh = runGitReadOperation(operation, { refresh: true });
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledTimes(2));
    const refreshed = {
      owner: "example",
      repo: "repo",
      branch: "new",
      root: operation.input.root,
    };
    fresh.resolve(refreshed);
    await expect(refresh).resolves.toEqual(refreshed);
    old.resolve({ ...refreshed, branch: "old" });
    await expect(pending).resolves.toMatchObject({ branch: "old" });
    await expect(runGitReadOperation(operation)).resolves.toEqual(refreshed);
    expect(gitRead).toHaveBeenCalledTimes(2);
  });

  it("expires pending unversioned branch facts from admission", async () => {
    vi.useFakeTimers();
    readRevision.mockResolvedValue(null);
    const held = holdRead("pull-request.branch-facts", undefined);
    const operation = {
      type: "pull-request.branch-facts" as const,
      input: {
        root: "/admission-expiry-null-true",
        branch: "feature",
        mergedHeads: [],
      },
    };
    const first = runGitReadOperation(operation);
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(74_000);
    const earlier = { creatable: true, stats: { additions: 1, deletions: 0, changedFiles: 1 } };
    vi.advanceTimersByTime(1_001);
    const fresh = { ...earlier, stats: { ...earlier.stats, additions: 2 } };
    gitRead.mockResolvedValueOnce(fresh);
    const current = runGitReadOperation(operation);
    await expect(current).resolves.toEqual(fresh);
    expect(gitRead).toHaveBeenCalledTimes(2);
    held.resolve(earlier);
    await first;
    await expect(runGitReadOperation(operation)).resolves.toEqual(fresh);
  });

  it.each(["checkout.diff", "checkout.revision"] as const)(
    "one cancelled subscriber cannot terminate a peer's %s operation",
    async (phase) => {
      const held = createDeferredCore<null>();
      onTestFinished(() => held.resolve(null));
      if (phase === "checkout.revision") {
        readRevision.mockReturnValueOnce(held.promise);
        gitRead.mockResolvedValue(emptyDiff);
      } else {
        gitRead.mockReturnValueOnce(held.promise.then(() => emptyDiff));
      }
      const operation = {
        type: "checkout.diff" as const,
        input: { cwd: `/shared-cancellation-${phase}` },
      };
      const first = new AbortController();
      const second = new AbortController();
      const cancelled = runGitReadOperation(operation, { signal: first.signal });
      const retained = runGitReadOperation(operation, { signal: second.signal });
      await vi.waitFor(() => expect(workerCalls(phase)).toHaveLength(1));
      const owner = workerCalls(phase)[0]?.[1]?.signal;
      const rejected = expect(cancelled).rejects.toThrow("first retired");
      first.abort(new Error("first retired"));
      await rejected;
      expect(owner?.aborted).toBe(false);
      held.resolve(null);
      await expect(retained).resolves.toEqual(emptyDiff);
      expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    },
  );

  it("keeps a shared read cached after its last viewer stops waiting", async () => {
    const held = holdRead("checkout.context", null);
    const operation = contextRead("/last-viewer");
    const viewer = new AbortController();
    const cancelled = runGitReadOperation(operation, { signal: viewer.signal });
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledOnce());
    const owner = gitRead.mock.calls[0]?.[1]?.signal;
    const rejected = expect(cancelled).rejects.toThrow("retired");
    viewer.abort(new Error("retired"));
    await rejected;
    expect(owner?.aborted).toBe(false);
    const current = { owner: "example", repo: "repo", branch: "current" };
    held.resolve(current);
    await expect(runGitReadOperation(operation)).resolves.toEqual(current);
    expect(gitRead).toHaveBeenCalledOnce();
  });

  it.each(["checkout.context", "checkout.revision"] as const)(
    "retires cached facts and pending %s reads with the Gateway lifecycle",
    async (phase) => {
      const held = createDeferredCore<null>();
      onTestFinished(() => held.resolve(null));
      if (phase === "checkout.revision") {
        readRevision.mockReturnValueOnce(held.promise);
      } else {
        gitRead.mockReturnValueOnce(held.promise);
      }
      const operation = contextRead(`/restart-lifecycle-${phase}`);
      const pending = runGitReadOperation(operation);
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(workerCalls(phase).length).toBeGreaterThan(0));
      const owner = workerCalls(phase)[0]?.[1]?.signal;
      const retiring = drainGlobalSingletonLifecycleState("restart");
      await Promise.resolve();
      expect(owner?.aborted).toBe(true);
      await expect(runGitReadOperation(operation)).rejects.toThrow("restarting");
      held.resolve(null);
      await rejected;
      await retiring;
      const current = { owner: "example", repo: "repo", branch: "reopened" };
      gitRead.mockResolvedValueOnce(current);
      await expect(runGitReadOperation(operation)).resolves.toEqual(current);
      expect(gitRead).toHaveBeenCalledTimes(phase === "checkout.context" ? 2 : 1);
    },
  );

  it.each(["checkout.context", "checkout.revision"] as const)(
    "a failed %s cannot poison the next normal request",
    async (phase) => {
      gitRead.mockResolvedValue(null);
      const failing = phase === "checkout.revision" ? readRevision : gitRead;
      failing.mockRejectedValueOnce(new Error("temporary failure"));
      const operation = contextRead(`/recovery-${phase}`);
      await expect(runGitReadOperation(operation)).rejects.toThrow("temporary failure");
      await expect(runGitReadOperation(operation)).resolves.toBeNull();
      expect(failing).toHaveBeenCalledTimes(2);
    },
  );
});
