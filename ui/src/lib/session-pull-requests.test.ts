import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayHarness,
  createHello,
  flushSync,
} from "./session-pull-requests.test-support.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionGitHubRepository,
  sessionPullRequestsForGateway,
} from "./session-pull-requests.ts";
import { scopedSessionArtifactKey } from "./sessions/session-key.ts";

function createStoreHarness() {
  const harness = createGatewayHarness();
  return { harness, store: sessionPullRequestsForGateway(harness.gateway), owner: {} };
}

function emitReadySnapshot(
  harness: ReturnType<typeof createGatewayHarness>,
  key: string,
  pullRequests: Array<{ number: number; state?: string }>,
) {
  harness.emit({ sessions: { [key]: { pullRequests, rateLimited: false, status: "ready" } } });
}

function expectSubscription(
  harness: ReturnType<typeof createGatewayHarness>,
  sessionKeys: string[],
  refreshSessionKeys?: string[],
) {
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys, ...(refreshSessionKeys ? { refreshSessionKeys } : {}) },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session pull request snapshot store", () => {
  it.each([false, true])(
    "requires operator.read and retires cached facts (cached: %s)",
    async (cached) => {
      vi.useFakeTimers();
      const { harness, store, owner } = createStoreHarness();
      const key = "agent:main:demo";
      if (cached) {
        store.watch(owner, [key], { foreground: true });
        await flushSync();
        emitReadySnapshot(harness, key, [{ number: 42, state: "open" }]);
        expect(store.get(key)?.pullRequests).toHaveLength(1);
      }
      harness.setSnapshot({
        ...harness.gateway.snapshot,
        hello: createHello(["operator.sessions.read", "operator.sessions.write"]),
      });
      store.watch(owner, [key], { foreground: true });
      await flushSync();
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

  it("coalesces refresh bursts while a subscription request is unsettled and keeps one trailing refresh", async () => {
    const { harness, store, owner } = createStoreHarness();
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    store.refresh(key);
    await flushSync();
    for (let n = 0; n < 10; n++) {
      store.refresh(key);
      await flushSync();
    }
    expect(harness.request).toHaveBeenCalledTimes(2);
    resolve({ subscribed: true });
    await flushSync();
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(3);
    store.unwatch(owner);
    await flushSync();
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
    const cases: Array<{
      name: string;
      initial: Snapshot;
      updates: Array<{
        received: Snapshot;
        expected: Snapshot;
        repository?: Snapshot["repository"] | null;
      }>;
    }> = [
      {
        name: "populated unavailable facts and later branch enrichment",
        initial: snapshot({
          repository,
          branch: { ...branch, additions: 1 },
          pullRequests: open,
          rateLimited: true,
          status: "rate-limited",
        }),
        updates: [
          { received: unavailable, expected: unavailable },
          {
            received: { ...unavailable, pullRequests: [], branch: changedBranch },
            expected: { ...unavailable, branch: changedBranch },
          },
        ],
      },
      ...(["unavailable", "rate-limited"] as const).map((status, index) => {
        const next = snapshot({
          repository,
          branch: { ...repository, branch: "feature/current", additions: 9 },
          rateLimited: status === "rate-limited",
          status,
        });
        return {
          name: `replacement branch during ${status} with ${index === 0 ? "branch" : "PR"} metadata`,
          initial: snapshot({
            repository,
            pullRequests: [{ number: 1, state: "open", branch: "feature/previous" }],
            ...(index === 0 ? { branch: { ...repository, branch: "feature/previous" } } : {}),
          }),
          updates: [{ received: next, expected: next }],
        };
      }),
      ...(["rate-limited", "unavailable"] as const).map((status) => ({
        name: `repository-only context during ${status} and its ready replacement`,
        initial: snapshot({ repository }),
        updates: [
          {
            received: snapshot({ status, rateLimited: status === "rate-limited" }),
            expected: snapshot({ repository, status, rateLimited: status === "rate-limited" }),
          },
          { received: snapshot(), expected: snapshot(), repository: null },
        ],
      })),
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
        return {
          name: `repository replacement during ${status}`,
          initial: snapshot({ repository, branch, pullRequests: open }),
          updates: [{ received: next, expected: next, repository: replacement }],
        };
      }),
      {
        name: "empty failure deltas retain PR facts and repository context",
        initial: snapshot({ repository, pullRequests: open }),
        updates: [
          {
            received: snapshot({ branch, rateLimited: true, status: "rate-limited" }),
            expected: snapshot({
              repository,
              branch,
              pullRequests: open,
              rateLimited: true,
              status: "rate-limited",
            }),
          },
          {
            received: snapshot({ status: "unavailable" }),
            expected: snapshot({ repository, branch, pullRequests: open, status: "unavailable" }),
          },
        ],
      },
    ];
    it.each(cases)("reconciles $name", async ({ initial, updates }) => {
      const { harness, store, owner } = createStoreHarness();
      const key = "agent:main:demo";
      store.watch(owner, [key]);
      await flushSync();
      harness.emit({ sessions: { [key]: initial } });
      for (const update of updates) {
        harness.emit({ sessions: { [key]: update.received } });
        expect(store.get(key)).toEqual(update.expected);
        if (update.repository !== undefined) {
          expect(sessionGitHubRepository(store.get(key))).toEqual(update.repository);
        }
      }
      store.unwatch(owner);
      await flushSync();
    });
  });

  it.each([
    { boundary: "reconnect", outcome: "resolve" },
    { boundary: "hello", outcome: "reject" },
  ] as const)(
    "preserves an unsettled forced refresh across $boundary and ignores its late $outcome",
    async ({ boundary, outcome }) => {
      const { harness, store, owner } = createStoreHarness();
      const key = "agent:main:demo";
      store.watch(owner, [key]);
      await flushSync();
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      harness.request.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          }),
      );
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
        resolve({ subscribed: true });
      } else {
        reject(new Error("retired request failed"));
      }
      await flushSync();
      await flushSync();
      expect(harness.request).toHaveBeenCalledTimes(calls);
      store.unwatch(owner);
      await flushSync();
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
    const { harness, store, owner } = createStoreHarness();
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
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
    store.unwatch(owner);
    await flushSync();
  });

  it.each(["branch-switch", "rewind", "send"])(
    "invalidates matching snapshots only for structural events (%s)",
    async (reason) => {
      vi.useFakeTimers();
      const { harness, store, owner } = createStoreHarness();
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
      const key = globalAlias ? "agent:work:main" : "agent:main:demo";
      const otherKey = "agent:main:other";
      store.watch(owner, [key, otherKey]);
      const unsubscribe = store.subscribe(listener);
      await flushSync();
      harness.emit({
        sessions: {
          [key]: { pullRequests: [{ number: 1 }], rateLimited: false, status: "ready" },
          [otherKey]: { pullRequests: [{ number: 2 }], rateLimited: false, status: "ready" },
        },
      });
      harness.request.mockClear();
      listener.mockClear();

      harness.emit(
        {
          sessionKey: globalAlias ? "global" : key,
          agentId: globalAlias ? "work" : "main",
          reason,
        },
        "sessions.changed",
      );

      if (structural) {
        expect(store.get(key)).toBeUndefined();
        expect(listener).toHaveBeenCalled();
      } else {
        expect(store.get(key)?.pullRequests).toEqual([{ number: 1 }]);
      }
      expect(store.get(otherKey)?.pullRequests).toEqual([{ number: 2 }]);
      await flushSync();
      expect(harness.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      if (structural) {
        expectSubscription(harness, [key, otherKey].toSorted(), [key]);
      } else {
        expect(harness.request).not.toHaveBeenCalled();
      }
      unsubscribe();
      store.unwatch(owner);
      await flushSync();
    },
  );

  it("detaches document and gateway listeners after the last consumer leaves", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const { harness, store, owner } = createStoreHarness();

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

    store.unwatch(owner);
    await flushSync();
    expectSubscription(harness, []);
    expect(harness.unsubscribeSnapshots).not.toHaveBeenCalled();
    expect(harness.unsubscribeEvents).not.toHaveBeenCalled();

    unsubscribe();
    await flushSync();
    expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
  });

  it("does not retry a failed subscribe after the store becomes idle", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    harness.request.mockRejectedValue(new Error("temporarily unavailable"));
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);

    store.unwatch(owner);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["watch", "load"] as const)(
    "reactivates a detached store for a fresh %s",
    async (mode) => {
      const { harness, store, owner } = createStoreHarness();
      const key = "agent:main:demo";
      store.watch(owner, [key]);
      await flushSync();
      emitReadySnapshot(harness, key, [{ number: 1, state: "open" }]);
      expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "open" }]);
      store.unwatch(owner);
      await flushSync();
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
      store.unwatch(owner);
      await flushSync();
    },
  );

  it("requests an immediate refresh for only the selected watched key", async () => {
    const { harness, store, owner } = createStoreHarness();
    store.watch(owner, ["agent:main:demo", "agent:main:other"]);
    await flushSync();
    harness.request.mockClear();

    expect(store.refresh("agent:main:unwatched")).toBe(false);
    expect(store.refresh("agent:main:demo")).toBe(true);
    expect(store.refresh("agent:main:demo")).toBe(true);
    await flushSync();

    expect(harness.request).toHaveBeenCalledOnce();
    expectSubscription(harness, ["agent:main:demo", "agent:main:other"], ["agent:main:demo"]);
    store.unwatch(owner);
    await flushSync();
  });

  it("debounces automatic bursts per session while an explicit refresh absorbs its timer", async () => {
    vi.useFakeTimers();
    const { harness, store, owner } = createStoreHarness();
    const first = "agent:main:first";
    const second = "agent:main:second";
    store.watch(owner, [first, second]);
    await flushSync();
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
    store.unwatch(owner);
    await flushSync();
  });

  it("coalesces tool and terminal activity for viewed sessions without refreshing passive rows", async () => {
    vi.useFakeTimers();
    const { harness, store, owner } = createStoreHarness();
    const passiveOwner = {};
    const viewed = "agent:main:demo";
    const passive = "agent:main:idle";
    store.watch(passiveOwner, [viewed, passive], { passive: true });
    store.watch(owner, [viewed], { foreground: true });
    await flushSync();
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
    expectSubscription(harness, [viewed], [viewed]);

    harness.emit({ sessionKey: viewed, stream: "tool", data: { phase: "result" } }, "agent");
    store.unwatch(owner);
    await flushSync();
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
    const { harness, store, owner } = createStoreHarness();
    store.watch(owner, ["agent:main:old"]);
    await flushSync();
    store.refresh("agent:main:old", { automatic: true });
    store.watch(owner, ["agent:main:next"]);
    await flushSync();
    harness.request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).not.toHaveBeenCalled();
    store.unwatch(owner);
    await flushSync();
  });

  it("retains an unsettled refresh across hiding and restoring the watched tab", async () => {
    const { harness, store, owner } = createStoreHarness();
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    store.refresh(key);
    await flushSync();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request.mock.calls.at(-1)?.[1]).toEqual({ sessionKeys: [] });
    resolve({ subscribed: true });
    await flushSync();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request.mock.calls.at(-1)?.[1]).toEqual({
      sessionKeys: [key],
      refreshSessionKeys: [key],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("carries a pending refresh into a superseding replace-set", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const foregroundOwner = {};
    const otherOwner = {};
    store.watch(foregroundOwner, ["agent:main:demo"], { foreground: true });
    await flushSync();
    harness.request.mockClear();
    let resolveFirst!: (value: { subscribed: boolean }) => void;
    const first = new Promise<{ subscribed: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    harness.request.mockReturnValueOnce(first);

    store.refresh("agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    expect(harness.request.mock.calls[1]?.[1]).toEqual({
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
    resolveFirst({ subscribed: true });
    store.unwatch(foregroundOwner);
    store.unwatch(otherOwner);
    await flushSync();
  });

  it("does not settle a one-shot load from an obsolete request failure", async () => {
    const harness = createGatewayHarness();
    let rejectFirst!: (error: Error) => void;
    harness.request.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    const store = sessionPullRequestsForGateway(harness.gateway);
    const loadOwner = {};
    const otherOwner = {};
    const loaded = store.load(loadOwner, "agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    rejectFirst(new Error("obsolete request failed"));
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
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
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
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
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
      const { harness, store, owner } = createStoreHarness();
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
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const key = "agent:main:demo";
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
    expectSubscription(harness, []);
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "merged" }]);
    store.unwatch(sidebar);
    await flushSync();
  });

  it("scopes global aliases without changing canonical keys", () => {
    expect(scopedSessionArtifactKey("global", "Work")).toBe("agent:work:global");
    expect(scopedSessionArtifactKey("agent:work:main", "main")).toBe("agent:work:main");
  });
});
