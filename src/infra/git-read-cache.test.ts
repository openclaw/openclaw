import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureSessionDiffBaseline, loadCheckoutDiff } from "../sessions/session-diff.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { runGitReadOperation } from "./git-read-cache.js";
import type { GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";

vi.mock("./git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

afterEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  vi.useRealTimers();
});

const emptyDiff = { files: [], additions: 0, deletions: 0 };

describe("typed Git read ownership", () => {
  it("shares concurrent checkout work without sharing session envelopes or settled file state", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const first = loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-a" });
    const second = loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-b" });
    await Promise.resolve();
    expect(runGitWorkerOperation).toHaveBeenCalledOnce();
    held.resolve(emptyDiff);
    await expect(first).resolves.toEqual({ ...emptyDiff, sessionKey: "session-a" });
    await expect(second).resolves.toEqual({ ...emptyDiff, sessionKey: "session-b" });
    vi.mocked(runGitWorkerOperation).mockResolvedValueOnce({ ...emptyDiff, additions: 3 });
    await expect(
      loadCheckoutDiff({ cwd: "/diff-sharing", sessionKey: "session-a" }),
    ).resolves.toMatchObject({ additions: 3 });
    expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
  });

  it("gives each coalesced response independent files and commit metadata", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
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
    expect(runGitWorkerOperation).toHaveBeenCalledOnce();
  });

  it("shares baseline fingerprints while binding each captured session independently", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.baseline"]["output"]>();
    onTestFinished(() => held.resolve(undefined));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const first = captureSessionDiffBaseline({ cwd: "/baseline-sharing", sessionId: "a" });
    const second = captureSessionDiffBaseline({ cwd: "/baseline-sharing", sessionId: "b" });
    await Promise.resolve();
    expect(runGitWorkerOperation).toHaveBeenCalledOnce();
    const captured = { version: 1 as const, root: "/baseline-sharing", files: [] };
    held.resolve(captured);
    await expect(first).resolves.toEqual({ ...captured, sessionId: "a" });
    await expect(second).resolves.toEqual({ ...captured, sessionId: "b" });
  });

  it("starts forced refresh immediately and an older completion cannot replace its result", async () => {
    const old = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => old.resolve(null));
    const fresh = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => fresh.resolve(null));
    vi.mocked(runGitWorkerOperation)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const operation = { type: "checkout.context" as const, input: { root: "/refresh-generation" } };
    const watcher = new AbortController();
    try {
      const pending = runGitReadOperation(operation, { cacheSignal: watcher.signal });
      const refresh = runGitReadOperation(operation, {
        refresh: true,
        cacheSignal: watcher.signal,
      });
      await Promise.resolve();
      expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
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
      expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
      expect(getEventListeners(watcher.signal, "abort")).toHaveLength(1);
    } finally {
      watcher.abort();
    }
    expect(getEventListeners(watcher.signal, "abort")).toHaveLength(0);
  });

  it.each([false, true])(
    "measures PR freshness from admission when the older read is pending=%s",
    async (pendingAtExpiry) => {
      vi.useFakeTimers();
      const held = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
      onTestFinished(() => held.resolve(null));
      vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
      const operation = {
        type: "checkout.context" as const,
        input: { root: `/admission-expiry-${pendingAtExpiry}` },
      };
      const first = runGitReadOperation(operation);
      await Promise.resolve();
      vi.advanceTimersByTime(74_000);
      const earlier = { owner: "example", repo: "repo", branch: "earlier" };
      if (!pendingAtExpiry) {
        held.resolve(earlier);
        await first;
      }
      vi.advanceTimersByTime(1_001);
      const fresh = { ...earlier, branch: "fresh" };
      vi.mocked(runGitWorkerOperation).mockResolvedValueOnce(fresh);
      const current = runGitReadOperation(operation);
      await Promise.resolve();
      expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
      await expect(current).resolves.toEqual(fresh);
      held.resolve(earlier);
      await first;
      await expect(runGitReadOperation(operation)).resolves.toEqual(fresh);
    },
  );

  it("one cancelled subscriber cannot terminate a peer's Git operation", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.diff"]["output"]>();
    onTestFinished(() => held.resolve(emptyDiff));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const operation = { type: "checkout.diff" as const, input: { cwd: "/shared-cancellation" } };
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = runGitReadOperation(operation, { signal: first.signal });
    const retained = runGitReadOperation(operation, { signal: second.signal });
    await Promise.resolve();
    const owner = vi.mocked(runGitWorkerOperation).mock.calls[0]?.[1]?.signal;
    const rejected = expect(cancelled).rejects.toThrow("first retired");
    first.abort(new Error("first retired"));
    await rejected;
    expect(owner?.aborted).toBe(false);
    held.resolve(emptyDiff);
    await expect(retained).resolves.toEqual(emptyDiff);
    expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
  });

  it("joins final-subscriber teardown while fresh readers avoid its stale generation", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => held.resolve(null));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const operation = { type: "checkout.context" as const, input: { root: "/last-subscriber" } };
    const subscriber = new AbortController();
    const cancelled = runGitReadOperation(operation, { signal: subscriber.signal });
    let callerSettled = false;
    const markSettled = () => {
      callerSettled = true;
    };
    const observed = cancelled.then(markSettled, markSettled);
    await Promise.resolve();
    const owner = vi.mocked(runGitWorkerOperation).mock.calls[0]?.[1]?.signal;
    const rejected = expect(cancelled).rejects.toThrow("retired");
    const current = { owner: "example", repo: "repo", branch: "current" };
    try {
      subscriber.abort(new Error("retired"));
      expect(owner?.aborted).toBe(true);
      vi.mocked(runGitWorkerOperation).mockResolvedValueOnce(current);
      await expect(runGitReadOperation(operation)).resolves.toEqual(current);
      expect(callerSettled).toBe(false);
    } finally {
      held.resolve(null);
      await rejected;
      await observed;
    }
    expect(callerSettled).toBe(true);
    await expect(runGitReadOperation(operation)).resolves.toEqual(current);
    expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
  });

  it("does not cancel admitted work when a subscription only releases retention", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => held.resolve(null));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const watcher = new AbortController();
    const pending = runGitReadOperation(
      { type: "checkout.context", input: { root: "/retention-only" } },
      { cacheSignal: watcher.signal },
    );
    await Promise.resolve();
    watcher.abort();
    expect(vi.mocked(runGitWorkerOperation).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    held.resolve(null);
    await expect(pending).resolves.toBeNull();
  });

  it("retires cached facts and pending reads with the Gateway lifecycle", async () => {
    const held = createDeferredCore<GitReadOperations["checkout.context"]["output"]>();
    onTestFinished(() => held.resolve(null));
    vi.mocked(runGitWorkerOperation).mockReturnValueOnce(held.promise);
    const watcher = new AbortController();
    const operation = { type: "checkout.context" as const, input: { root: "/restart-lifecycle" } };
    const pending = runGitReadOperation(operation, { cacheSignal: watcher.signal });
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    const owner = vi.mocked(runGitWorkerOperation).mock.calls[0]?.[1]?.signal;
    const retiring = drainGlobalSingletonLifecycleState("restart");
    await Promise.resolve();
    expect(owner?.aborted).toBe(true);
    expect(getEventListeners(watcher.signal, "abort")).toHaveLength(0);
    await expect(runGitReadOperation(operation)).rejects.toThrow("restarting");
    held.resolve({ owner: "example", repo: "repo", branch: "retired" });
    await rejected;
    await retiring;
    const current = { owner: "example", repo: "repo", branch: "reopened" };
    vi.mocked(runGitWorkerOperation).mockResolvedValueOnce(current);
    await expect(runGitReadOperation(operation, { cacheSignal: watcher.signal })).resolves.toEqual(
      current,
    );
    expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
    watcher.abort();
  });

  it("a failed read cannot poison the next normal request", async () => {
    vi.mocked(runGitWorkerOperation)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(null);
    const operation = { type: "checkout.context" as const, input: { root: "/recovery" } };
    await expect(runGitReadOperation(operation)).rejects.toThrow("temporary failure");
    await expect(runGitReadOperation(operation)).resolves.toBeNull();
    expect(runGitWorkerOperation).toHaveBeenCalledTimes(2);
  });
});
