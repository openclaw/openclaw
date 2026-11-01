import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  createGatewayHarness,
  createHello,
  flushSync,
} from "./session-pull-requests.test-support.ts";
import { sessionGitHubRepository, sessionPullRequestsForGateway } from "./session-pull-requests.ts";
import { scopedSessionArtifactKey } from "./sessions/session-key.ts";

let harness: ReturnType<typeof createGatewayHarness>;
let store: ReturnType<typeof sessionPullRequestsForGateway>;
let owner: object;
const key = "agent:main:demo";
beforeEach(() => {
  harness = createGatewayHarness();
  store = sessionPullRequestsForGateway(harness.gateway);
  owner = {};
});

async function watch(keys = [key], options?: Parameters<typeof store.watch>[2]) {
  store.watch(owner, keys, options);
  await flushSync();
}

async function unwatch() {
  store.unwatch(owner);
  await flushSync();
}

async function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
  await flushSync();
}

function emitReadySnapshot(
  source: ReturnType<typeof createGatewayHarness>,
  sessionKey: string,
  pullRequests: Array<{ number: number; state?: string }>,
) {
  source.emit({
    sessions: { [sessionKey]: { pullRequests, rateLimited: false, status: "ready" } },
  });
}

function expectSubscription(
  source: ReturnType<typeof createGatewayHarness>,
  sessionKeys: string[],
  refreshSessionKeys?: string[],
  passiveSessionKeys?: string[],
) {
  expect(source.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    {
      sessionKeys,
      ...(refreshSessionKeys ? { refreshSessionKeys } : {}),
      ...(passiveSessionKeys ? { passiveSessionKeys } : {}),
    },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session pull request snapshot store", () => {
  it("clears own imported PR facts after a keyless identity withdrawal", async () => {
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      hello: createHello(["operator.sessions.write"]),
    });
    const importKey = "agent:main:own-import";
    await watch([importKey], { foreground: true });
    expectSubscription(harness, [importKey]);
    emitReadySnapshot(harness, importKey, [{ number: 7, state: "open" }]);
    expect(store.get(importKey)?.pullRequests).toHaveLength(1);
    harness.emit({ reason: "profile-identity" }, "sessions.changed");
    expect(store.get(importKey)).toBeUndefined();
    await flushSync();
    expectSubscription(harness, [importKey], [importKey]);
    store.unwatch(owner);
  });
  it("retires broad snapshots and passive reads when only own-session reads remain", async () => {
    const importKey = "agent:main:own-import";
    const passiveOwner = {};
    store.watch(owner, [importKey], { foreground: true });
    store.watch(passiveOwner, ["agent:main:other"], { passive: true });
    await flushSync();
    emitReadySnapshot(harness, importKey, [{ number: 42, state: "open" }]);
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      hello: createHello(["operator.sessions.write"]),
    });
    expect(store.get(importKey)).toBeUndefined();
    await flushSync();
    expectSubscription(harness, [importKey]);
    emitReadySnapshot(harness, importKey, [{ number: 7, state: "open" }]);
    expect(store.get(importKey)?.pullRequests).toEqual([{ number: 7, state: "open" }]);
    store.unwatch(owner);
    store.unwatch(passiveOwner);
  });

  it.each([false, true])(
    "requires session reading and retires cached facts (cached: %s)",
    async (cached) => {
      vi.useFakeTimers();
      if (cached) {
        await watch([key], { foreground: true });
        emitReadySnapshot(harness, key, [{ number: 42, state: "open" }]);
        expect(store.get(key)?.pullRequests).toHaveLength(1);
      }
      harness.setSnapshot({
        ...harness.gateway.snapshot,
        hello: createHello(["operator.approvals"]),
      });
      await watch([key], { foreground: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get(key)).toBeUndefined();
      expect(harness.request).toHaveBeenCalledTimes(cached ? 1 : 0);
      expect(await store.load({}, key)).toBeUndefined();

      harness.setSnapshot({ ...harness.gateway.snapshot, hello: createHello() });
      await flushSync();
      expectSubscription(harness, [key]);
      expect(store.get(key)).toBeUndefined();
      expect(harness.request).toHaveBeenCalledTimes(cached ? 2 : 1);
      store.unwatch(owner);
    },
  );

  it("hydrates passive receipts and promotes only the active viewer to GitHub reads", async () => {
    const passiveOwner = {};
    store.watch(passiveOwner, [key], { passive: true });
    await flushSync();
    expectSubscription(harness, [], undefined, [key]);
    await watch([key], { foreground: true });
    expect(harness.request).toHaveBeenCalledTimes(2);
    expectSubscription(harness, [key]);
    await unwatch();
    expect(harness.request).toHaveBeenCalledTimes(3);
    expectSubscription(harness, [], undefined, [key]);
    store.unwatch(passiveOwner);
  });

  it("retains branch and matching task metadata in receipt-only updates without reviving removed receipts", async () => {
    vi.useFakeTimers();
    const sidebar = {};
    const branch = { owner: "example", repo: "repository", branch: "feature/parent" };
    const pullRequest = { ...branch, number: 40, state: "open" };
    const task = (number: number) => ({
      ...branch,
      url: `https://github.com/example/repository/pull/${number}`,
      number,
      sourceSessionKey: `agent:main:child-${number}`,
      sourceAgentId: "main",
    });
    const retained = { ...task(1), pullRequest: { ...pullRequest, number: 1 } };
    store.watch(sidebar, [key], { passive: true });
    await watch([key], { foreground: true });
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [pullRequest],
          branch,
          repository: branch,
          taskPullRequests: [retained, task(2)],
          taskPullRequestCount: 2,
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await unwatch();
    harness.emit({
      sessions: {
        [key]: {
          branchRead: false,
          pullRequests: [],
          taskPullRequests: [task(1)],
          taskPullRequestCount: 1,
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(store.get(key)).toMatchObject({
      branchRead: false,
      branch,
      pullRequests: [pullRequest],
      taskPullRequests: [retained],
      taskPullRequestCount: 1,
    });
    const calls = harness.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(calls);
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [],
          taskPullRequests: [],
          taskPullRequestCount: 0,
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(store.get(key)?.pullRequests).toEqual([]);
    expect(store.get(key)?.taskPullRequests).toEqual([]);
    store.unwatch(sidebar);
  });

  it("coalesces refresh bursts while a subscription request is unsettled and keeps one trailing refresh", async () => {
    await watch([key]);
    const pending = createDeferred<unknown>();
    harness.request.mockReturnValueOnce(pending.promise);
    store.refresh(key);
    await flushSync();
    for (let n = 0; n < 10; n++) {
      store.refresh(key);
      await flushSync();
    }
    expect(harness.request).toHaveBeenCalledTimes(2);
    pending.resolve({ subscribed: true });
    await flushSync();
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(3);
    await unwatch();
  });

  describe("snapshot reconciliation", () => {
    const repository = { owner: "openclaw", repo: "openclaw" };
    const branch = { ...repository, branch: "feature/demo" };
    const open = [{ number: 1, state: "open" }];
    type Snapshot = {
      pullRequests: Array<{ number: number; state?: string; branch?: string }>;
      repository?: { owner: string; repo: string };
      branch?: typeof branch & { additions?: number };
      rateLimited: boolean;
      status: string;
      discardPrevious?: true;
    };
    const snapshot = (fields: Partial<Snapshot> = {}): Snapshot => ({
      pullRequests: [],
      rateLimited: false,
      status: "ready",
      ...fields,
    });
    const unavailable = snapshot({
      repository,
      pullRequests: [{ number: 1, state: "merged" }],
      status: "unavailable",
    });
    const changedBranch = { ...branch, additions: 9 };
    type Update = [
      received: Snapshot,
      expected: Snapshot,
      repository?: Snapshot["repository"] | null,
    ];
    function scenario(name: string, initial: Snapshot, ...updates: Update[]) {
      return { name, initial, updates };
    }
    const cases = [
      scenario(
        "withdrawn imported association without reviving previous facts",
        snapshot({ repository, pullRequests: open }),
        [
          snapshot({ status: "unavailable", discardPrevious: true }),
          snapshot({ status: "unavailable", discardPrevious: true }),
          null,
        ],
      ),
      scenario(
        "populated unavailable facts and later branch enrichment",
        snapshot({
          repository,
          branch: { ...branch, additions: 1 },
          pullRequests: open,
          rateLimited: true,
          status: "rate-limited",
        }),
        [unavailable, unavailable],
        [
          { ...unavailable, pullRequests: [], branch: changedBranch },
          { ...unavailable, branch: changedBranch },
        ],
      ),
      ...(["unavailable", "rate-limited"] as const).map((status, index) => {
        const next = snapshot({
          repository,
          branch: { ...repository, branch: "feature/current", additions: 9 },
          rateLimited: status === "rate-limited",
          status,
        });
        return scenario(
          `replacement branch during ${status} with ${index === 0 ? "branch" : "PR"} metadata`,
          snapshot({
            repository,
            pullRequests: [{ number: 1, state: "open", branch: "feature/previous" }],
            ...(index === 0 ? { branch: { ...repository, branch: "feature/previous" } } : {}),
          }),
          [next, next],
        );
      }),
      ...(["rate-limited", "unavailable"] as const).map((status) =>
        scenario(
          `repository-only context during ${status} and its ready replacement`,
          snapshot({ repository }),
          [
            snapshot({ status, rateLimited: status === "rate-limited" }),
            snapshot({ repository, status, rateLimited: status === "rate-limited" }),
          ],
          [snapshot(), snapshot(), null],
        ),
      ),
      ...(
        [
          { status: "unavailable", repository: { owner: "other", repo: "openclaw" } },
          { status: "rate-limited", repository: { owner: "openclaw", repo: "other" } },
        ] as const
      ).map(({ status, repository: replacement }) => {
        const next = snapshot({
          repository: replacement,
          status,
          rateLimited: status === "rate-limited",
        });
        return scenario(
          `repository replacement during ${status}`,
          snapshot({ repository, branch, pullRequests: open }),
          [next, next, replacement],
        );
      }),
      scenario(
        "empty failure deltas retain PR facts and repository context",
        snapshot({ repository, pullRequests: open }),
        [
          snapshot({ branch, rateLimited: true, status: "rate-limited" }),
          snapshot({
            repository,
            branch,
            pullRequests: open,
            rateLimited: true,
            status: "rate-limited",
          }),
        ],
        [
          snapshot({ status: "unavailable" }),
          snapshot({ repository, branch, pullRequests: open, status: "unavailable" }),
        ],
      ),
    ];
    it.each(cases)("reconciles $name", async ({ initial, updates }) => {
      await watch([key]);
      harness.emit({ sessions: { [key]: initial } });
      for (const [received, expected, expectedRepository] of updates) {
        harness.emit({ sessions: { [key]: received } });
        expect(store.get(key)).toEqual(expected);
        if (expectedRepository !== undefined) {
          expect(sessionGitHubRepository(store.get(key))).toEqual(expectedRepository);
        }
      }
      await unwatch();
    });
  });

  it.each([
    { boundary: "reconnect", outcome: "resolve" },
    { boundary: "hello", outcome: "reject" },
  ] as const)(
    "preserves an unsettled forced refresh across $boundary and ignores its late $outcome",
    async ({ boundary, outcome }) => {
      await watch([key]);
      const pending = createDeferred<unknown>();
      harness.request.mockReturnValueOnce(pending.promise);
      store.refresh(key);
      await flushSync();
      const connected = harness.gateway.snapshot;
      if (boundary === "reconnect") {
        harness.setSnapshot({ ...connected, phase: "stopped", hello: null });
        await flushSync();
      }
      harness.setSnapshot({ ...connected, hello: createHello() });
      await flushSync();
      expectSubscription(harness, [key], [key]);
      const calls = harness.request.mock.calls.length;
      if (outcome === "resolve") {
        pending.resolve({ subscribed: true });
      } else {
        pending.reject(new Error("retired request failed"));
      }
      await flushSync();
      await flushSync();
      expect(harness.request).toHaveBeenCalledTimes(calls);
      await unwatch();
    },
  );
  it("derives the repository from explicit context, branch, then the first pull request", () => {
    const repository = { owner: "explicit", repo: "checkout" };
    const branch = { owner: "branch-owner", repo: "checkout", branch: "feature/demo" };
    const pullRequest = {
      owner: "pr-owner",
      repo: "checkout",
      branch: "feature/demo",
      number: 123,
      title: "Demo",
      url: "https://github.com/pr-owner/checkout/pull/123",
      state: "open" as const,
    };
    const snapshot = { repository, branch, pullRequests: [pullRequest], rateLimited: false };
    expect(sessionGitHubRepository(snapshot)).toEqual(repository);
    expect(sessionGitHubRepository({ ...snapshot, repository: undefined })).toEqual({
      owner: "branch-owner",
      repo: "checkout",
    });
    expect(
      sessionGitHubRepository({ ...snapshot, repository: undefined, branch: undefined }),
    ).toEqual({
      owner: "pr-owner",
      repo: "checkout",
    });
    expect(sessionGitHubRepository({ pullRequests: [], rateLimited: false })).toBeNull();
    expect(sessionGitHubRepository(undefined)).toBeNull();
  });

  it("retires snapshots and resubscribes normally across a same-client reconnect", async () => {
    await watch([key]);
    emitReadySnapshot(harness, key, [{ number: 1, state: "open" }]);
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "open" }]);

    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    expect(store.get(key)).toBeUndefined();

    harness.setSnapshot({
      ...harness.gateway.snapshot,
      phase: "connected",
      hello: createHello(),
    });
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expectSubscription(harness, [key]);
    await unwatch();
  });

  it.each(["branch-switch", "rewind", "send"])(
    "invalidates matching snapshots only for structural events (%s)",
    async (reason) => {
      vi.useFakeTimers();
      const listener = vi.fn();
      const globalAlias = reason === "rewind";
      const structural = reason !== "send";
      harness.setSnapshot({
        ...harness.gateway.snapshot,
        hello: {
          ...createHello(),
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: globalAlias ? "global" : "agent:main:main",
              scope: globalAlias ? "global" : "per-sender",
            },
          },
        },
      });
      const eventKey = globalAlias ? "agent:work:main" : "agent:main:demo";
      const otherKey = "agent:main:other";
      store.watch(owner, [eventKey, otherKey]);
      const unsubscribe = store.subscribe(listener);
      await flushSync();
      harness.emit({
        sessions: {
          [eventKey]: { pullRequests: [{ number: 1 }], rateLimited: false, status: "ready" },
          [otherKey]: { pullRequests: [{ number: 2 }], rateLimited: false, status: "ready" },
        },
      });
      harness.request.mockClear();
      listener.mockClear();

      harness.emit(
        {
          sessionKey: globalAlias ? "global" : eventKey,
          agentId: globalAlias ? "work" : "main",
          reason,
        },
        "sessions.changed",
      );

      if (structural) {
        expect(store.get(eventKey)).toBeUndefined();
        expect(listener).toHaveBeenCalled();
      } else {
        expect(store.get(eventKey)?.pullRequests).toEqual([{ number: 1 }]);
      }
      expect(store.get(otherKey)?.pullRequests).toEqual([{ number: 2 }]);
      await flushSync();
      expect(harness.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      if (structural) {
        expectSubscription(harness, [eventKey, otherKey].toSorted(), [eventKey]);
      } else {
        expect(harness.request).not.toHaveBeenCalled();
      }
      unsubscribe();
      await unwatch();
    },
  );

  it("detaches document and gateway listeners after the last consumer leaves", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");

    expect(harness.subscribeSnapshots).not.toHaveBeenCalled();
    expect(harness.subscribeEvents).not.toHaveBeenCalled();
    store.watch(owner, ["agent:main:demo"]);
    const unsubscribe = store.subscribe(() => undefined);
    await flushSync();

    expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.subscribeEvents).toHaveBeenCalledOnce();
    const visibilityListener = addEventListener.mock.calls.find(
      ([type]) => type === "visibilitychange",
    )?.[1];
    expect(visibilityListener).toBeTypeOf("function");

    await unwatch();
    expectSubscription(harness, []);
    expect(harness.unsubscribeSnapshots).not.toHaveBeenCalled();
    expect(harness.unsubscribeEvents).not.toHaveBeenCalled();

    unsubscribe();
    await flushSync();
    expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
    expect(removeEventListener.mock.calls).toContainEqual(
      expect.arrayContaining(["visibilitychange", visibilityListener]),
    );
  });

  it("does not retry a failed subscribe after the store becomes idle", async () => {
    vi.useFakeTimers();
    harness.request.mockRejectedValue(new Error("temporarily unavailable"));
    await watch(["agent:main:demo"]);
    expect(harness.request).toHaveBeenCalledTimes(1);

    await unwatch();
    expect(harness.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["watch", "load"] as const)(
    "reactivates a detached store for a fresh %s",
    async (mode) => {
      await watch([key]);
      emitReadySnapshot(harness, key, [{ number: 1, state: "open" }]);
      expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "open" }]);
      await unwatch();
      expect(store.get(key)).toBeUndefined();
      expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
      expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();

      emitReadySnapshot(harness, key, [{ number: 99, state: "open" }]);
      const loaded = mode === "load" ? store.load(owner, key) : undefined;
      if (mode === "watch") {
        store.watch(owner, [key]);
      }
      await flushSync();
      expect(harness.subscribeSnapshots).toHaveBeenCalledTimes(2);
      expect(harness.subscribeEvents).toHaveBeenCalledTimes(2);
      expectSubscription(harness, [key]);
      emitReadySnapshot(harness, key, [{ number: 2, state: "open" }]);
      expect(store.get(key)?.pullRequests).toEqual([{ number: 2, state: "open" }]);
      if (loaded) {
        await expect(loaded).resolves.toMatchObject({ status: "ready" });
      }
      await unwatch();
    },
  );

  it("debounces automatic bursts per session while an explicit refresh absorbs its timer", async () => {
    vi.useFakeTimers();
    const first = "agent:main:first";
    const second = "agent:main:second";
    await watch([first, second]);
    harness.request.mockClear();

    store.refresh(first, { automatic: true });
    store.refresh(second, { automatic: true });
    await vi.advanceTimersByTimeAsync(2_000);
    store.refresh(first, { automatic: true });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(harness.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expectSubscription(harness, [first, second], [second]);

    store.refresh(first);
    await flushSync();
    await flushSync();
    expectSubscription(harness, [first, second], [first]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).toHaveBeenCalledTimes(2);
    await unwatch();
  });

  it("coalesces tool and terminal activity for viewed sessions without refreshing passive rows", async () => {
    vi.useFakeTimers();
    const passiveOwner = {};
    const viewed = "agent:main:demo";
    const passive = "agent:main:idle";
    store.watch(passiveOwner, [viewed, passive], { passive: true });
    await watch([viewed], { foreground: true });
    harness.request.mockClear();

    for (const event of ["agent", "session.tool"]) {
      for (const sessionKey of [viewed, passive]) {
        harness.emit({ sessionKey, stream: "tool", data: { phase: "result" } }, event);
      }
    }
    for (const phase of ["end", "error"]) {
      harness.emit({ sessionKey: viewed, stream: "lifecycle", data: { phase } }, "agent");
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).toHaveBeenCalledOnce();
    expectSubscription(harness, [viewed], [viewed], [passive]);

    harness.emit({ sessionKey: viewed, stream: "tool", data: { phase: "result" } }, "agent");
    await unwatch();
    harness.request.mockClear();
    harness.emit({ sessionKey: viewed, stream: "tool", data: { phase: "result" } }, "session.tool");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).not.toHaveBeenCalled();
    expect(store.refresh(passive)).toBe(false);
    store.unwatch(passiveOwner);
    await flushSync();
  });

  it("drops a delayed automatic refresh when its watch is replaced", async () => {
    vi.useFakeTimers();
    await watch(["agent:main:old"]);
    store.refresh("agent:main:old", { automatic: true });
    await watch(["agent:main:next"]);
    harness.request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).not.toHaveBeenCalled();
    await unwatch();
  });

  it("retains an unsettled refresh across hiding and restoring the watched tab", async () => {
    await watch([key]);
    const pending = createDeferred<unknown>();
    harness.request.mockReturnValueOnce(pending.promise);
    store.refresh(key);
    await flushSync();
    await setVisibility("hidden");
    expect(harness.request.mock.calls.at(-1)?.[1]).toEqual({ sessionKeys: [] });
    pending.resolve({ subscribed: true });
    await flushSync();
    await setVisibility("visible");
    expect(harness.request.mock.calls.at(-1)?.[1]).toEqual({
      sessionKeys: [key],
      refreshSessionKeys: [key],
    });
    await unwatch();
  });

  it("carries a pending refresh into a superseding replace-set", async () => {
    const foregroundOwner = {};
    const otherOwner = {};
    store.watch(foregroundOwner, ["agent:main:demo"], { foreground: true });
    await flushSync();
    harness.request.mockClear();
    const first = createDeferred<{ subscribed: boolean }>();
    harness.request.mockReturnValueOnce(first.promise);

    store.refresh("agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    expect(harness.request.mock.calls[1]?.[1]).toEqual({
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
    first.resolve({ subscribed: true });
    store.unwatch(foregroundOwner);
    store.unwatch(otherOwner);
    await flushSync();
  });

  it("does not settle a one-shot load from an obsolete request failure", async () => {
    const first = createDeferred<never>();
    harness.request.mockReturnValueOnce(first.promise);
    const loadOwner = {};
    const otherOwner = {};
    const loaded = store.load(loadOwner, "agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    first.reject(new Error("obsolete request failed"));
    await flushSync();
    let settled = false;
    void loaded.then(() => {
      settled = true;
    });
    await flushSync();
    expect(settled).toBe(false);

    emitReadySnapshot(harness, "agent:main:demo", []);
    await expect(loaded).resolves.toMatchObject({ status: "ready" });
    store.unwatch(otherOwner);
    await flushSync();
  });

  it("does not resubscribe when foreground promotion only reorders watched keys", async () => {
    const sidebarOwner = {};
    const hovercardOwner = {};
    store.watch(sidebarOwner, ["agent:main:first", "agent:main:second"]);
    await flushSync();
    harness.request.mockClear();

    store.watch(hovercardOwner, ["agent:main:second"], { foreground: true });
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();

    store.unwatch(hovercardOwner);
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();

    store.unwatch(sidebarOwner);
    await flushSync();
  });

  it("updates the bounded server union and snapshots when foreground priority changes", async () => {
    const normalOwner = {};
    const foregroundOwner = {};
    const normalKeys = Array.from(
      { length: 201 },
      (_value, index) => `normal-${String(index).padStart(3, "0")}`,
    );
    store.watch(normalOwner, normalKeys);
    await flushSync();
    harness.request.mockClear();

    store.watch(foregroundOwner, ["normal-200"], { foreground: true });
    await flushSync();

    expect(harness.request).toHaveBeenCalledOnce();
    const params = harness.request.mock.lastCall?.[1] as { sessionKeys: string[] };
    expect(params.sessionKeys).toHaveLength(200);
    expect(params.sessionKeys[0]).toBe("normal-200");
    expect(params.sessionKeys).not.toContain("normal-199");
    const snapshot = { pullRequests: [], rateLimited: false, status: "ready" };
    harness.emit({ sessions: { "normal-199": snapshot, "normal-200": snapshot } });
    expect(store.get("normal-199")).toBeUndefined();
    expect(store.get("normal-200")).toEqual(snapshot);

    store.watch(foregroundOwner, ["normal-200"]);
    await flushSync();

    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request.mock.lastCall?.[1]).toEqual({
      sessionKeys: normalKeys.slice(0, 200),
    });
    expect(store.get("normal-200")).toBeUndefined();
    harness.emit({ sessions: { "normal-199": snapshot, "normal-200": snapshot } });
    expect(store.get("normal-199")).toEqual(snapshot);
    expect(store.get("normal-200")).toBeUndefined();
    store.unwatch(normalOwner);
    store.unwatch(foregroundOwner);
    await flushSync();
  });

  it.each(["disconnected", "unwatch", "disconnect"] as const)(
    "settles a one-shot load when %s",
    async (transition) => {
      const disconnect = () =>
        harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
      if (transition === "disconnected") {
        disconnect();
      } else {
        harness.request.mockReturnValue(new Promise<never>(() => {}));
      }
      const loaded = store.load(owner, "agent:main:demo");
      await flushSync();
      if (transition === "unwatch") {
        store.unwatch(owner);
      } else if (transition === "disconnect") {
        disconnect();
        await flushSync();
      }
      await expect(loaded).resolves.toBeUndefined();
      store.unwatch(owner);
    },
  );

  it("refreshes a passive snapshot when a one-shot load immediately replaces its viewer", async () => {
    const sidebar = {};
    const viewer = {};
    store.watch(sidebar, [key], { passive: true });
    store.watch(viewer, [key], { foreground: true });
    await flushSync();
    emitReadySnapshot(harness, key, [{ number: 1, state: "open" }]);
    store.unwatch(viewer);
    const loaded = store.load({}, key);
    await flushSync();
    expectSubscription(harness, [key], [key]);
    emitReadySnapshot(harness, key, [{ number: 1, state: "merged" }]);
    await expect(loaded).resolves.toMatchObject({
      pullRequests: [{ number: 1, state: "merged" }],
    });
    await flushSync();
    expectSubscription(harness, [], undefined, [key]);
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "merged" }]);
    store.unwatch(sidebar);
    await flushSync();
  });

  it("scopes global aliases without changing canonical keys", () => {
    expect(scopedSessionArtifactKey("global", "Work")).toBe("agent:work:global");
    expect(scopedSessionArtifactKey("agent:work:main", "main")).toBe("agent:work:main");
  });
});
