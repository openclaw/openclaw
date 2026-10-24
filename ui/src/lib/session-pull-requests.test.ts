import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
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

let harness: ReturnType<typeof createGatewayHarness>;
let store: ReturnType<typeof sessionPullRequestsForGateway>;
let owner: object;
const owners = new Set<object>();
const key = "agent:main:demo";
const otherKey = "agent:main:other";
const repository = { owner: "openclaw", repo: "openclaw" };
const branch = { ...repository, branch: "feature/demo" };
const open = [{ number: 1, state: "open" }];
beforeEach(() => {
  harness = createGatewayHarness();
  store = sessionPullRequestsForGateway(harness.gateway);
  owners.clear();
  owner = createOwner();
});

function createOwner() {
  const consumer = {};
  owners.add(consumer);
  return consumer;
}

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
  sessionKey: string,
  pullRequests: Array<{ number: number; state?: string }>,
) {
  emitSnapshot({ pullRequests }, sessionKey);
}

function emitSnapshot<T extends object>(fields: T, sessionKey = key) {
  harness.emit({
    sessions: {
      [sessionKey]: { pullRequests: [], rateLimited: false, status: "ready", ...fields },
    },
  });
}

function expectPullRequests(
  pullRequests: Array<{ number: number; state?: string }>,
  sessionKey = key,
) {
  expect(store.get(sessionKey)?.pullRequests).toEqual(pullRequests);
}

function expectGatewayListeners(method: "subscribe" | "unsubscribe", count: number) {
  expect(harness[`${method}Snapshots`]).toHaveBeenCalledTimes(count);
  expect(harness[`${method}Events`]).toHaveBeenCalledTimes(count);
}

function patchGateway(fields: Partial<Parameters<typeof harness.setSnapshot>[0]>) {
  harness.setSnapshot({ ...harness.gateway.snapshot, ...fields });
}

function expectSubscription(
  sessionKeys: string[],
  refreshSessionKeys?: string[],
  passiveSessionKeys?: string[],
) {
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    {
      sessionKeys,
      ...(refreshSessionKeys ? { refreshSessionKeys } : {}),
      ...(passiveSessionKeys ? { passiveSessionKeys } : {}),
    },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
}

afterEach(async () => {
  for (const consumer of owners) {
    store.unwatch(consumer);
  }
  await flushSync();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session pull request snapshot store", () => {
  it("clears own imported PR facts after a keyless identity withdrawal", async () => {
    patchGateway({ hello: createHello(["operator.sessions.write"]) });
    const importKey = "agent:main:own-import";
    await watch([importKey], { foreground: true });
    expectSubscription([importKey]);
    emitReadySnapshot(importKey, [{ number: 7, state: "open" }]);
    expect(store.get(importKey)?.pullRequests).toHaveLength(1);
    harness.emit({ reason: "profile-identity" }, "sessions.changed");
    expect(store.get(importKey)).toBeUndefined();
    await flushSync();
    expectSubscription([importKey], [importKey]);
  });
  it("retires broad snapshots and passive reads when only own-session reads remain", async () => {
    const importKey = "agent:main:own-import";
    const passiveOwner = createOwner();
    store.watch(owner, [importKey], { foreground: true });
    store.watch(passiveOwner, [otherKey], { passive: true });
    await flushSync();
    emitReadySnapshot(importKey, [{ number: 42, state: "open" }]);
    patchGateway({ hello: createHello(["operator.sessions.write"]) });
    expect(store.get(importKey)).toBeUndefined();
    await flushSync();
    expectSubscription([importKey]);
    emitReadySnapshot(importKey, [{ number: 7, state: "open" }]);
    expectPullRequests([{ number: 7, state: "open" }], importKey);
  });

  it.each([false, true])(
    "requires session reading and retires cached facts (cached: %s)",
    async (cached) => {
      vi.useFakeTimers();
      if (cached) {
        await watch([key], { foreground: true });
        emitReadySnapshot(key, [{ number: 42, state: "open" }]);
        expect(store.get(key)?.pullRequests).toHaveLength(1);
      }
      patchGateway({ hello: createHello(["operator.approvals"]) });
      await watch([key], { foreground: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get(key)).toBeUndefined();
      expect(harness.request).toHaveBeenCalledTimes(cached ? 1 : 0);
      expect(await store.load({}, key)).toBeUndefined();

      patchGateway({ hello: createHello() });
      await flushSync();
      expectSubscription([key]);
      expect(store.get(key)).toBeUndefined();
      expect(harness.request).toHaveBeenCalledTimes(cached ? 2 : 1);
    },
  );

  it("retains branch and matching task metadata in receipt-only updates without reviving removed receipts", async () => {
    vi.useFakeTimers();
    const sidebar = createOwner();
    const pullRequest = { ...branch, number: 40, state: "open" };
    const task = (number: number) => ({
      ...branch,
      url: `https://github.com/openclaw/openclaw/pull/${number}`,
      number,
      sourceSessionKey: `agent:main:child-${number}`,
      sourceAgentId: "main",
    });
    const retained = { ...task(1), pullRequest: { ...pullRequest, number: 1 } };
    store.watch(sidebar, [key], { passive: true });
    await flushSync();
    expectSubscription([], undefined, [key]);
    await watch([key], { foreground: true });
    expectSubscription([key]);
    emitSnapshot({
      pullRequests: [pullRequest],
      branch,
      repository: branch,
      taskPullRequests: [retained, task(2)],
      taskPullRequestCount: 2,
    });
    await unwatch();
    expectSubscription([], undefined, [key]);
    emitSnapshot({
      branchRead: false,
      pullRequests: [],
      taskPullRequests: [task(1)],
      taskPullRequestCount: 1,
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
    emitSnapshot({ taskPullRequests: [], taskPullRequestCount: 0 });
    expectPullRequests([]);
    expect(store.get(key)?.taskPullRequests).toEqual([]);
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
  });

  describe("snapshot reconciliation", () => {
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
    const previousBranch = { ...repository, branch: "feature/previous" };
    const previousPr = [{ number: 1, state: "open", branch: previousBranch.branch }];
    type Update = [received: Snapshot, expected?: Snapshot];
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
        [unavailable],
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
          "branch replacement from " + (index === 0 ? "branch" : "PR"),
          snapshot({
            repository,
            pullRequests: previousPr,
            ...(index === 0 ? { branch: previousBranch } : {}),
          }),
          [next],
        );
      }),
      ...(["rate-limited", "unavailable"] as const).map((status) =>
        scenario(
          "repository-only " + status + " then ready",
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
      for (const [received, expected = received] of updates) {
        harness.emit({ sessions: { [key]: received } });
        expect(store.get(key)).toEqual(expected);
      }
    });
  });

  it.each([
    { boundary: "reconnect", pending: true, reject: false },
    { boundary: "hello", pending: true, reject: true },
    { boundary: "reconnect", pending: false, reject: false },
    { boundary: "hidden", pending: true, reject: false },
    { boundary: "membership", pending: true, reject: false },
  ])(
    "reconciles $boundary with pending refresh: $pending",
    async ({ boundary, pending, reject }) => {
      await watch();
      emitReadySnapshot(key, open);
      const reply = createDeferred<unknown>();
      const otherOwner = createOwner();
      if (pending) {
        harness.request.mockReturnValueOnce(reply.promise);
        store.refresh(key);
        await flushSync();
      }
      const connected = harness.gateway.snapshot;
      if (boundary === "reconnect") {
        patchGateway({ phase: "reconnecting", hello: null });
        expect(store.get(key)).toBeUndefined();
        await flushSync();
      }
      if (boundary === "hidden") {
        await setVisibility("hidden");
        expectSubscription([]);
        reply.resolve({ subscribed: true });
        await flushSync();
        await setVisibility("visible");
      } else if (boundary === "membership") {
        store.watch(otherOwner, [otherKey]);
        await flushSync();
      } else {
        harness.setSnapshot({ ...connected, hello: createHello() });
        await flushSync();
      }
      expectSubscription(
        boundary === "membership" ? [key, otherKey] : [key],
        pending ? [key] : undefined,
      );
      const calls = harness.request.mock.calls.length;
      if (!pending) {
        expect(calls).toBe(2);
      }
      if (reject) {
        reply.reject(new Error("retired request failed"));
      } else {
        reply.resolve({ subscribed: true });
      }
      await flushSync();
      await flushSync();
      expect(harness.request).toHaveBeenCalledTimes(calls);
    },
  );
  it("derives the repository from explicit context, branch, then the first pull request", () => {
    const pullRequest = {
      ...branch,
      owner: "pr-owner",
      number: 123,
      title: "PR",
      url: "https://github.com/pr-owner/openclaw/pull/123",
      state: "open" as const,
    };
    const snapshot = {
      branch: { ...branch, owner: "branch-owner" },
      pullRequests: [pullRequest],
      rateLimited: false,
    };
    expect(sessionGitHubRepository({ ...snapshot, repository })).toEqual(repository);
    expect(sessionGitHubRepository(snapshot)).toEqual({ ...repository, owner: "branch-owner" });
    expect(sessionGitHubRepository({ ...snapshot, branch: undefined })).toEqual({
      ...repository,
      owner: "pr-owner",
    });
    expect(sessionGitHubRepository({ pullRequests: [], rateLimited: false })).toBeNull();
    expect(sessionGitHubRepository(undefined)).toBeNull();
  });

  it.each(["branch-switch", "rewind", "send"])(
    "invalidates matching snapshots only for structural events (%s)",
    async (reason) => {
      vi.useFakeTimers();
      const listener = vi.fn();
      const globalAlias = reason === "rewind";
      const structural = reason !== "send";
      patchGateway({
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
      const eventKey = globalAlias ? "agent:work:main" : key;
      store.watch(owner, [eventKey, otherKey]);
      const unsubscribe = store.subscribe(listener);
      await flushSync();
      emitReadySnapshot(eventKey, [{ number: 1 }]);
      emitReadySnapshot(otherKey, [{ number: 2 }]);
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
        expectPullRequests([{ number: 1 }], eventKey);
      }
      expectPullRequests([{ number: 2 }], otherKey);
      await flushSync();
      expect(harness.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      if (structural) {
        expectSubscription([eventKey, otherKey].toSorted(), [eventKey]);
      } else {
        expect(harness.request).not.toHaveBeenCalled();
      }
      unsubscribe();
    },
  );

  it("detaches document and gateway listeners after the last consumer leaves", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");

    expectGatewayListeners("subscribe", 0);
    store.watch(owner, [key]);
    const unsubscribe = store.subscribe(() => undefined);
    await flushSync();

    expectGatewayListeners("subscribe", 1);
    const visibilityListener = addEventListener.mock.calls.find(
      ([type]) => type === "visibilitychange",
    )?.[1];
    expect(visibilityListener).toBeTypeOf("function");

    await unwatch();
    expectSubscription([]);
    expectGatewayListeners("unsubscribe", 0);

    unsubscribe();
    await flushSync();
    expectGatewayListeners("unsubscribe", 1);
    expect(removeEventListener.mock.calls).toContainEqual(
      expect.arrayContaining(["visibilitychange", visibilityListener]),
    );
  });

  it("does not retry a failed subscribe after the store becomes idle", async () => {
    vi.useFakeTimers();
    harness.request.mockRejectedValue(new Error("temporarily unavailable"));
    await watch([key]);
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
      emitReadySnapshot(key, open);
      await unwatch();
      expect(store.get(key)).toBeUndefined();
      expectGatewayListeners("unsubscribe", 1);

      emitReadySnapshot(key, [{ number: 99, state: "open" }]);
      const loaded = mode === "load" ? store.load(owner, key) : undefined;
      if (mode === "watch") {
        store.watch(owner, [key]);
      }
      await flushSync();
      expectGatewayListeners("subscribe", 2);
      expectSubscription([key]);
      emitReadySnapshot(key, [{ number: 2, state: "open" }]);
      expectPullRequests([{ number: 2, state: "open" }]);
      if (loaded) {
        await expect(loaded).resolves.toMatchObject({ status: "ready" });
      }
      await unwatch();
    },
  );

  it("requests an immediate refresh for only the selected watched key", async () => {
    await watch(["agent:main:demo", "agent:main:other"]);
    harness.request.mockClear();

    expect(store.refresh("agent:main:unwatched")).toBe(false);
    expect(store.refresh("agent:main:demo")).toBe(true);
    expect(store.refresh("agent:main:demo")).toBe(true);
    await flushSync();

    expect(harness.request).toHaveBeenCalledOnce();
    expectSubscription([key, otherKey], [key]);
    await unwatch();
  });

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
    expectSubscription([first, second], [second]);

    store.refresh(first);
    await flushSync();
    await flushSync();
    expectSubscription([first, second], [first]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it("coalesces tool and terminal activity for viewed sessions without refreshing passive rows", async () => {
    vi.useFakeTimers();
    const passiveOwner = createOwner();
    const viewed = key;
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
    expectSubscription([viewed], [viewed], [passive]);

    harness.emit({ sessionKey: viewed, stream: "tool", data: { phase: "result" } }, "agent");
    await unwatch();
    harness.request.mockClear();
    harness.emit({ sessionKey: viewed, stream: "tool", data: { phase: "result" } }, "session.tool");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).not.toHaveBeenCalled();
    expect(store.refresh(passive)).toBe(false);
  });

  it("drops a delayed automatic refresh when its watch is replaced", async () => {
    vi.useFakeTimers();
    await watch(["agent:main:old"]);
    store.refresh("agent:main:old", { automatic: true });
    await watch(["agent:main:next"]);
    harness.request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("does not settle a one-shot load from an obsolete request failure", async () => {
    const first = createDeferred<never>();
    harness.request.mockReturnValueOnce(first.promise);
    const loadOwner = createOwner();
    const otherOwner = createOwner();
    const loaded = store.load(loadOwner, key);
    await flushSync();
    store.watch(otherOwner, [otherKey]);
    await flushSync();

    first.reject(new Error("obsolete request failed"));
    await flushSync();
    let settled = false;
    void loaded.then(() => {
      settled = true;
    });
    await flushSync();
    expect(settled).toBe(false);

    emitReadySnapshot(key, []);
    await expect(loaded).resolves.toMatchObject({ status: "ready" });
  });

  it("does not resubscribe when foreground promotion only reorders watched keys", async () => {
    const sidebarOwner = createOwner();
    const hovercardOwner = createOwner();
    store.watch(sidebarOwner, ["agent:main:first", "agent:main:second"]);
    await flushSync();
    harness.request.mockClear();

    store.watch(hovercardOwner, ["agent:main:second"], { foreground: true });
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();

    store.unwatch(hovercardOwner);
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("updates the bounded server union and snapshots when foreground priority changes", async () => {
    const normalOwner = createOwner();
    const foregroundOwner = createOwner();
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
  });

  it.each(["disconnected", "unwatch", "disconnect"] as const)(
    "settles a one-shot load when %s",
    async (transition) => {
      const disconnect = () => patchGateway({ phase: "reconnecting", hello: null });
      if (transition === "disconnected") {
        disconnect();
      } else {
        harness.request.mockReturnValue(new Promise<never>(() => {}));
      }
      const loaded = store.load(owner, key);
      await flushSync();
      if (transition === "unwatch") {
        store.unwatch(owner);
      } else if (transition === "disconnect") {
        disconnect();
        await flushSync();
      }
      await expect(loaded).resolves.toBeUndefined();
    },
  );

  it("refreshes a passive snapshot when a one-shot load immediately replaces its viewer", async () => {
    const sidebar = createOwner();
    const viewer = createOwner();
    store.watch(sidebar, [key], { passive: true });
    store.watch(viewer, [key], { foreground: true });
    await flushSync();
    emitReadySnapshot(key, open);
    store.unwatch(viewer);
    const loaded = store.load({}, key);
    await flushSync();
    expectSubscription([key], [key]);
    emitReadySnapshot(key, [{ number: 1, state: "merged" }]);
    await expect(loaded).resolves.toMatchObject({
      pullRequests: [{ number: 1, state: "merged" }],
    });
    await flushSync();
    expectSubscription([], undefined, [key]);
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "merged" }]);
  });
});
