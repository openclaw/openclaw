import { getEventListeners } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createControlUiSessionPullRequestSubscriptions as createSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";

const fixture = createSessionPullRequestsFixture();
const loadPrs = fixture.load;

vi.mock("../infra/git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

let cacheEpochMs = Date.now();
const subscriptionsToStop = new Set<ReturnType<typeof createSubscriptions>>();
const mergedPull = pullListItem({ merged_at: "2026-07-09T10:00:00Z" });

function stubPulls(response: () => Response, includeRepository = false) {
  const fetchImpl = routedFetch([
    { match: "/pulls?head=", response },
    ...(includeRepository
      ? [{ match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) }]
      : []),
  ]);
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function loadFromRoot(root: string | ((key: string) => string), signals?: Set<AbortSignal>) {
  return (params: Parameters<typeof loadPrs>[0], cacheSignal?: AbortSignal) => {
    if (cacheSignal) {
      signals?.add(cacheSignal);
    }
    return loadPrs(params, {
      cacheSignal,
      resolveGitRoot: async () => (typeof root === "string" ? root : root(params.sessionKey)),
    });
  };
}

function localGitReads() {
  return vi
    .mocked(runGitWorkerOperation)
    .mock.calls.filter(
      ([operation]) =>
        operation.type !== "checkout.revision" &&
        operation.type !== "pull-request.branch-comparison",
    );
}

const listenerCount = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const watchedKeys = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => `watched-${index + offset}`);

function mockCheckout(
  revision: () => string | null,
  branch: (root: string) => string | null,
  additions?: () => number,
) {
  vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
    switch (operation.type) {
      case "pull-request.branch-comparison":
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      case "checkout.revision":
        return revision();
      case "checkout.context": {
        const selected = branch(operation.input.root);
        return selected
          ? {
              ...testGitContext,
              branch: selected,
              root: operation.input.root,
              defaultBranch: "main",
            }
          : null;
      }
      case "pull-request.branch-facts":
        return additions
          ? { creatable: true, stats: { additions: additions(), deletions: 0, changedFiles: 1 } }
          : undefined;
      default:
        throw new Error("Unexpected local Git operation");
    }
  });
}

function subscribe(
  options: Pick<Parameters<typeof createSubscriptions>[0], "load" | "broadcastToConnIds">,
) {
  const subscriptions = createSubscriptions({
    scheduler: createTestGatewayScheduler("fake-timers"),
    prepareRead: fixture.prepareRead,
    ...options,
  });
  subscriptionsToStop.add(subscriptions);
  return subscriptions;
}

beforeEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  cacheEpochMs += 10 * 60_000;
  vi.setSystemTime(cacheEpochMs);
});

afterEach(async () => {
  for (const subscriptions of subscriptionsToStop) {
    await subscriptions.stop();
  }
  subscriptionsToStop.clear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watched session PR retention", () => {
  it("shares checkout facts across subscribers and refreshes both only when refs change", async () => {
    let revision = "first-head";
    let additions = 1;
    stubPulls(() => githubJson([]), true);
    mockCheckout(
      () => revision,
      () => "shared-feature",
      () => additions,
    );
    const broadcastToConnIds = vi.fn();
    const subscriptions = subscribe({
      broadcastToConnIds,
      load: loadFromRoot("/watched/shared-checkout"),
    });
    const expectReads = (count: number) => {
      for (const type of ["checkout.context", "pull-request.branch-facts"]) {
        expect(localGitReads().filter(([operation]) => operation.type === type)).toHaveLength(
          count,
        );
      }
    };
    const expectDelivered = (connId: string, sessionKey: string, expectedAdditions: number) => {
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "controlUi.sessionPullRequests.changed",
        {
          sessions: {
            [sessionKey]: expect.objectContaining({
              status: "ready",
              branch: expect.objectContaining({ additions: expectedAdditions }),
            }),
          },
        },
        new Set([connId]),
        expect.anything(),
      );
    };
    await Promise.all([
      subscriptions.replace("first", ["shared-first"]),
      subscriptions.replace("second", ["shared-second"]),
    ]);
    expectReads(1);
    expectDelivered("first", "shared-first", 1);
    expectDelivered("second", "shared-second", 1);

    broadcastToConnIds.mockClear();
    await subscriptions.replace("first", ["shared-first"], new Set(["shared-first"]));
    await subscriptions.pollNow();
    expectReads(1);
    expectDelivered("first", "shared-first", 1);

    revision = "second-head";
    additions = 2;
    broadcastToConnIds.mockClear();
    await subscriptions.pollNow();
    expectReads(2);
    expectDelivered("first", "shared-first", 2);
    expectDelivered("second", "shared-second", 2);

    subscriptions.unsubscribe("first");
    broadcastToConnIds.mockClear();
    await subscriptions.replace("second", ["shared-second"], new Set(["shared-second"]));
    expectReads(2);
    expectDelivered("second", "shared-second", 2);
  });

  it("keeps every watched branch's last-good chips through quota backoff", async () => {
    let limited = false;
    const fetchImpl = stubPulls(() => (limited ? githubJson({}, 429) : githubJson([mergedPull])));
    const snapshots = new Map<string, unknown>();
    const expectSnapshots = (rateLimited: boolean) => {
      for (const snapshot of snapshots.values()) {
        expect(snapshot).toEqual(
          expect.objectContaining({
            rateLimited,
            pullRequests: [expect.anything()],
            repository: { owner: "openclaw", repo: "openclaw" },
          }),
        );
      }
    };
    const subscriptions = subscribe({
      broadcastToConnIds: (_event, payload) => {
        if (!isRecord(payload) || !isRecord(payload.sessions)) {
          throw new Error("invalid subscription event");
        }
        for (const [key, snapshot] of Object.entries(payload.sessions)) {
          expect(snapshot).toMatchObject({
            rateLimited: expect.any(Boolean),
            pullRequests: expect.any(Array),
          });
          snapshots.set(key, snapshot);
        }
      },
      load: (params, cacheSignal) =>
        loadPrs(params, {
          cacheSignal,
          resolveGitContext: async () => ({
            ...testGitContext,
            branch: params.sessionKey,
          }),
        }),
    });
    const keys = Array.from({ length: 101 }, (_, index) => `quota-${index}`);
    await subscriptions.replace("watcher", keys);
    expect(fetchImpl.mock.calls).toHaveLength(101);
    limited = true;
    vi.setSystemTime(Date.now() + 90_001);
    await subscriptions.pollNow();
    const callsAtBackoff = fetchImpl.mock.calls.length;
    expect(callsAtBackoff).toBeGreaterThan(101);
    expectSnapshots(true);
    vi.setSystemTime(Date.now() + 61_000);
    await subscriptions.replace("watcher", keys, new Set(keys));
    expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
    expectSnapshots(true);
    limited = false;
    vi.setSystemTime(Date.now() + 240_001);
    await subscriptions.pollNow();
    expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff + 101);
    expectSnapshots(false);
  });

  it("retains GitHub snapshots for the watched union across a poll", async () => {
    const fetchImpl = stubPulls(() => githubJson([mergedPull]));
    const signals = new Set<AbortSignal>();
    mockCheckout(
      () => "unchanged",
      (root) => root.slice("/watched/".length),
    );
    const subscriptions = subscribe({
      broadcastToConnIds: vi.fn(),
      load: loadFromRoot((key) => `/watched/${key}`, signals),
    });
    await subscriptions.replace("first", watchedKeys(200));
    await subscriptions.replace("second", watchedKeys(100, 200));
    expect(fetchImpl.mock.calls).toHaveLength(300);
    expect(localGitReads()).toHaveLength(600);

    for (const elapsed of [60_000, 15_001]) {
      vi.setSystemTime(Date.now() + elapsed);
      await subscriptions.pollNow();
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(localGitReads()).toHaveLength(600);
    }
    vi.setSystemTime(Date.now() + 225_000);
    await subscriptions.pollNow();
    expect(localGitReads()).toHaveLength(900);
    expect(signals.size).toBe(300);
    expect([...signals].map(listenerCount)).toEqual(Array<number>(300).fill(1));
    await subscriptions.stop();
    subscriptionsToStop.delete(subscriptions);
    expect([...signals].every((signal) => signal.aborted && listenerCount(signal) === 0)).toBe(
      true,
    );
  });

  it("releases obsolete GitHub snapshots when a watched checkout changes or disappears", async () => {
    const cacheLifetime = new AbortController();
    let root: string | null = "/retained/first";
    let branch: string | null = "feature-a";
    let rootFailure = false;
    let fetchFailure = false;
    stubPulls(() => githubJson(fetchFailure ? {} : [], fetchFailure ? 503 : 200), true);
    mockCheckout(
      () => branch,
      () => branch,
    );
    const load = () =>
      loadPrs(
        { sessionKey: "retained", refresh: true },
        {
          cacheSignal: cacheLifetime.signal,
          resolveGitRoot: async () => {
            if (rootFailure) {
              throw new Error("session unavailable");
            }
            return root;
          },
        },
      );
    const pins = () => listenerCount(cacheLifetime.signal);
    try {
      for (const [nextRoot, nextBranch, expectedPins] of [
        [root, branch, 1],
        ["/retained/second", "feature-b", 1],
        [null, "feature-b", 0],
      ] as const) {
        root = nextRoot;
        branch = nextBranch;
        await load();
        expect(pins()).toBe(expectedPins);
      }
      root = "/retained/third";
      branch = "feature-c";
      fetchFailure = true;
      await expect(load()).resolves.toEqual({
        pullRequests: [],
        repository: { owner: "openclaw", repo: "openclaw" },
        rateLimited: false,
        status: "unavailable",
      });
      // Keep the GitHub failure expiry pinned until this watch retires.
      expect(pins()).toBe(1);
      fetchFailure = false;
      vi.setSystemTime(Date.now() + 30_001);
      await load();
      expect(pins()).toBe(1);
      branch = null;
      await load();
      expect(pins()).toBe(0);
      rootFailure = true;
      await expect(load()).rejects.toThrow("session unavailable");
      expect(pins()).toBe(0);
    } finally {
      cacheLifetime.abort();
    }
    expect(pins()).toBe(0);
  });
});
