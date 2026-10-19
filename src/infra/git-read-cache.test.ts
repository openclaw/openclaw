import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureSessionDiffBaseline, loadCheckoutDiff } from "../sessions/session-diff.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { runGitReadOperation } from "./git-read-cache.js";
import type { GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";

vi.mock("./git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

const gitRead = vi.fn<typeof runGitWorkerOperation>();
const readRevision = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  readRevision.mockResolvedValue("unchanged");
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

describe("typed Git read ownership", () => {
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
    readRevision.mockResolvedValue(null);
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    gitRead.mockReturnValueOnce(held.promise);
    const input = { cwd: "/summary-sharing", summaryOnly: true };
    const first = loadCheckoutDiff({ ...input, sessionKey: "first" });
    await vi.waitFor(() => expect(gitRead).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(15_000);
    const second = loadCheckoutDiff({ ...input, sessionKey: "second" });
    await Promise.resolve();
    expect(gitRead).toHaveBeenCalledOnce();
    held.resolve({ ...emptyDiff, additions: 2 });
    await expect(first).resolves.toMatchObject({ sessionKey: "first", additions: 2 });
    await expect(second).resolves.toMatchObject({ sessionKey: "second", additions: 2 });
    gitRead.mockResolvedValueOnce({ ...emptyDiff, additions: 3 });
    await expect(loadCheckoutDiff({ ...input, sessionKey: "first" })).resolves.toMatchObject({
      additions: 3,
    });
    await expect(loadCheckoutDiff({ ...input, sessionKey: "second" })).resolves.toMatchObject({
      additions: 3,
    });
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
    readRevision.mockResolvedValue("edited-checkout");
    await expect(read(summary)).resolves.toMatchObject({ additions: 2 });
    await expect(read(input)).resolves.toMatchObject({ additions: 2 });
    expect(gitRead).toHaveBeenCalledTimes(6);
    await read(summary);
    await read(input);
    expect(gitRead).toHaveBeenCalledTimes(6);
    await drainGlobalSingletonLifecycleState("restart");
    await read(input);
    expect(gitRead).toHaveBeenCalledTimes(7);
    readRevision.mockResolvedValue("retryable-checkout");
    gitRead.mockResolvedValueOnce({ ...emptyDiff, unavailableReason: "not_git" });
    await read(input);
    await expect(read(input)).resolves.toMatchObject({ additions: 2 });
    expect(gitRead).toHaveBeenCalledTimes(9);
  });

  it("shares only in-flight revision checks with identical inputs and environment", async () => {
    const held = createDeferredCore<string>();
    onTestFinished(() => held.resolve("unchanged"));
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
    held.resolve("unchanged");
    await Promise.all([first, otherCheckout, otherBase, second, otherEnvironment]);
    expect(revisionCount).toBe(4);
    expect(gitRead).toHaveBeenCalledTimes(3);
    readRevision.mockResolvedValue("edited");
    await read(input);
    expect(readRevision).toHaveBeenCalledTimes(5);
    expect(gitRead).toHaveBeenCalledTimes(4);
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
    const old = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => old.resolve(null));
    const fresh = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => fresh.resolve(null));
    gitRead.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
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
      await vi.waitFor(() =>
        expect(
          vi.mocked(runGitWorkerOperation).mock.calls.filter(([command]) => command.type === phase),
        ).toHaveLength(1),
      );
      const owner = vi
        .mocked(runGitWorkerOperation)
        .mock.calls.find(([command]) => command.type === phase)?.[1]?.signal;
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
      await vi.waitFor(() =>
        expect(
          vi.mocked(runGitWorkerOperation).mock.calls.some(([command]) => command.type === phase),
        ).toBe(true),
      );
      const owner = vi
        .mocked(runGitWorkerOperation)
        .mock.calls.find(([command]) => command.type === phase)?.[1]?.signal;
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
