import { getEventListeners } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createControlUiSessionPullRequestSubscriptions as createSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import {
  spyOnSessionPrLoader,
  type SessionPrLoader,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  localPrGitReads as localGitReads,
  mockPrCheckout,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";

const fixture = createSessionPullRequestsFixture();
const loadPrs = fixture.load;

vi.mock("../infra/git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

let cacheEpochMs = Date.now();
let elapsedMs = 0;
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

const listenerCount = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
const watchedKeys = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => `watched-${index + offset}`);

function mockCheckout(
  revision: () => string | null,
  branch: (root: string) => string | null,
  additions?: () => number,
) {
  mockPrCheckout({
    revision,
    additions,
    emptyFacts: true,
    resolve: (root) => {
      const selected = branch(root);
      return selected ? { ...testGitContext, branch: selected, root, defaultBranch: "main" } : null;
    },
  });
}

function subscribe(
  load: SessionPrLoader,
  broadcastToConnIds: Parameters<typeof createSubscriptions>[0]["broadcastToConnIds"] = vi.fn(),
) {
  spyOnSessionPrLoader(load);
  const subscriptions = createSubscriptions({
    scheduler: createTestGatewayScheduler("fake-timers"),
    prepareRead: fixture.prepareRead,
    broadcastToConnIds,
  });
  subscriptionsToStop.add(subscriptions);
  return subscriptions;
}

async function pollAfter(subscriptions: ReturnType<typeof subscribe>, elapsed: number) {
  // Move cache clocks without firing the scheduler's queued polls.
  elapsedMs += elapsed;
  vi.setSystemTime(Date.now() + elapsed);
  await subscriptions.pollNow();
}

beforeEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  vi.useFakeTimers();
  elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
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
  vi.restoreAllMocks();
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
    const subscriptions = subscribe(loadFromRoot("/watched/shared-checkout"), broadcastToConnIds);
    const expectReads = (count: number) => {
      for (const type of ["checkout.context", "pull-request.branch-facts"]) {
        expect(localGitReads().filter(([operation]) => operation.type === type)).toHaveLength(
          count,
        );
      }
    };
    const expectDelivered = (connId: string, sessionKey: string, expectedAdditions: number) => {
      const snapshot = expect.objectContaining({
        status: "ready",
        branch: expect.objectContaining({ additions: expectedAdditions }),
      });
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "controlUi.sessionPullRequests.changed",
        { sessions: { [sessionKey]: snapshot } },
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
    const subscriptions = subscribe(
      (params, cacheSignal) =>
        loadPrs(params, {
          cacheSignal,
          resolveGitContext: async () => ({ ...testGitContext, branch: params.sessionKey }),
        }),
      (_event, payload) => {
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
    );
    const keys = Array.from({ length: 101 }, (_, index) => `quota-${index}`);
    await subscriptions.replace("watcher", keys);
    expect(fetchImpl.mock.calls).toHaveLength(101);
    limited = true;
    await pollAfter(subscriptions, 90_001);
    const callsAtBackoff = fetchImpl.mock.calls.length;
    expect(callsAtBackoff).toBeGreaterThan(101);
    expectSnapshots(true);
    vi.setSystemTime(Date.now() + 61_000);
    await subscriptions.replace("watcher", keys, new Set(keys));
    expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
    expectSnapshots(true);
    limited = false;
    await pollAfter(subscriptions, 240_001);
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
    const subscriptions = subscribe(loadFromRoot((key) => `/watched/${key}`, signals));
    await subscriptions.replace("first", watchedKeys(200));
    await subscriptions.replace("second", watchedKeys(100, 200));
    expect(fetchImpl.mock.calls).toHaveLength(300);
    expect(localGitReads()).toHaveLength(600);

    for (const elapsed of [60_000, 15_001]) {
      await pollAfter(subscriptions, elapsed);
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(localGitReads()).toHaveLength(600);
    }
    await pollAfter(subscriptions, 225_000);
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
    let root: string | null = null;
    let branch: string | null = null;
    let response: 200 | 503 | "throws" = 200;
    stubPulls(() => githubJson(response === 503 ? {} : [], response === 503 ? 503 : 200), true);
    mockCheckout(
      () => {
        if (response === "throws") {
          throw new Error("session unavailable");
        }
        return branch;
      },
      () => branch,
    );
    const load = () =>
      loadPrs(
        { sessionKey: "retained", refresh: true },
        {
          cacheSignal: cacheLifetime.signal,
          resolveGitRoot: async () => root,
        },
      );
    const pins = () => listenerCount(cacheLifetime.signal);
    try {
      // Walk the same watch through moves, absent roots, failures, recovery and detach.
      for (const [nextRoot, nextBranch, result, elapsed, expectedPins] of [
        ["/retained/first", "feature-a", 200, 0, 1],
        ["/retained/second", "feature-b", 200, 0, 1],
        [null, "feature-b", 200, 0, 0],
        ["/retained/third", "feature-c", 503, 0, 1],
        ["/retained/third", "feature-c", 200, 30_001, 1],
        ["/retained/third", null, 200, 0, 0],
        ["/retained/third", "feature-c", 200, 0, 1],
        ["/retained/third", "feature-c", "throws", 0, 0],
      ] as const) {
        root = nextRoot;
        branch = nextBranch;
        response = result;
        vi.setSystemTime(Date.now() + elapsed);
        if (result === "throws") {
          await expect(load()).rejects.toThrow("session unavailable");
        } else if (result === 503) {
          await expect(load()).resolves.toEqual({
            pullRequests: [],
            repository: { owner: "openclaw", repo: "openclaw" },
            rateLimited: false,
            status: "unavailable",
          });
        } else {
          await load();
        }
        expect(pins()).toBe(expectedPins);
      }
    } finally {
      cacheLifetime.abort();
    }
    expect(pins()).toBe(0);
  });
});
