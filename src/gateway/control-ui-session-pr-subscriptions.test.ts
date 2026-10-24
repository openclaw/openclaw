import { getEventListeners } from "node:events";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPullRequests as Snapshot } from "./control-ui-contract.js";
import { parseControlUiSessionPullRequestsSubscribeParams as parse } from "./control-ui-session-pr-subscriptions.js";
import {
  createTestControlUiSessionPrSubscriptions,
  createTestSessionPrReadSource,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import type { ControlUiSessionPullRequestsParams as LoadParams } from "./control-ui-session-prs.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";

const READY: Snapshot = { pullRequests: [], rateLimited: false };

let running: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;
let broadcastToConnIds: ReturnType<typeof vi.fn<Options["broadcastToConnIds"]>>;

beforeEach(() => {
  broadcastToConnIds = vi.fn<Options["broadcastToConnIds"]>();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  vi.useRealTimers();
});

type Options = Parameters<typeof createTestControlUiSessionPrSubscriptions>[0];
function start(
  options: Omit<Options, "scheduler" | "broadcastToConnIds"> & { scheduler?: Options["scheduler"] },
) {
  const { scheduler = createTestGatewayScheduler(), ...deps } = options;
  running = createTestControlUiSessionPrSubscriptions({
    scheduler,
    broadcastToConnIds,
    ...deps,
  });
  return running;
}

function publication(connId: string, key = "session", rateLimited = false) {
  return [
    CHANGED_EVENT,
    {
      sessions: {
        [key]: { ...READY, rateLimited, status: rateLimited ? "rate-limited" : "ready" },
      },
    },
    new Set([connId]),
    { sessionKeys: [key], agentId: "main" },
  ] as const;
}

function expectPublication(connId: string, key = "session", rateLimited = false) {
  expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    ...publication(connId, key, rateLimited),
  );
}

function loadArgs(sessionKey: string, refresh?: true) {
  return [
    { sessionKey, agentId: "main", ...(refresh ? { refresh } : {}) },
    expect.any(AbortSignal),
    expect.objectContaining({ assertCurrent: expect.any(Function) }),
  ] as const;
}

function expectSessions(
  load: { mock: { calls: readonly (readonly unknown[])[] } },
  keys: string[],
) {
  expect(load.mock.calls.map(([params]) => params)).toEqual(
    keys.map((sessionKey) => ({ sessionKey, agentId: "main" })),
  );
}

describe("control UI session PR subscriptions", () => {
  it.each([
    { facts: "category", invalidated: undefined, refresh: false },
    { facts: undefined, invalidated: "category", refresh: false },
    { facts: "category", invalidated: true, refresh: true },
    { facts: "unchanged", invalidated: true, refresh: true },
  ] as const)(
    "refreshes=$refresh for facts=$facts, invalidated=$invalidated",
    async ({ facts, invalidated, refresh }) => {
      const readSource = createTestSessionPrReadSource();
      const readCurrent = vi.fn(async () => ({
        sessionId: "session-id",
        params: { sessionKey: "session", agentId: "main" },
        identity: "session",
        readSource,
        source: null,
        taskReceipts: { sessions: [] },
      }));
      const active = start({ prepareRead: async () => readCurrent, load: async () => READY });
      await active.replace("reader", ["session"]);
      readCurrent.mockClear();
      broadcastToConnIds.mockClear();
      sessionChanges.emit({
        sessionKey: "session",
        facts:
          facts === "category"
            ? { kind: facts, sessionId: "session-id", category: "work" }
            : facts && { kind: facts },
        factsInvalidated: invalidated,
      });
      await nextEventLoopTurn();
      expect(readCurrent.mock.calls.length > 0).toBe(refresh);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cleanup: "stop", failing: true },
    { cleanup: "disconnect", failing: false },
    { cleanup: "empty replace", failing: false },
  ])(
    "retires cache retention before late completion on $cleanup with failing=$failing",
    async ({ cleanup, failing }) => {
      const cache = createRetainedCache<number>();
      const entered = createDeferred();
      const held = createDeferred();
      const signals: AbortSignal[] = [];
      const active = start({
        load: async ({ sessionKey }, signal) => {
          if (!signal) {
            throw new Error("missing watched-key lifetime");
          }
          signals.push(signal);
          cache.set(sessionKey, 1, signal);
          if (signals.length === 1) {
            entered.resolve();
            await held.promise;
          }
          cache.set(sessionKey, 2, signal);
          if (failing) {
            throw new Error("synthetic load failure");
          }
          return READY;
        },
      });
      const initial = active.replace("first", ["shared"]);
      await entered.promise;
      const retired = signals[0]!;
      expect(getEventListeners(retired, "abort")).toHaveLength(1);
      const operations: Promise<unknown>[] = [initial];
      try {
        if (cleanup === "stop") {
          operations.push(active.stop());
        } else if (cleanup === "disconnect") {
          active.unsubscribe("first");
        } else {
          await active.replace("first", []);
        }
        expect([retired.aborted, getEventListeners(retired, "abort").length]).toEqual([true, 0]);
        if (cleanup !== "stop") {
          operations.push(active.replace("second", ["shared"]));
        }
        held.resolve();
        await Promise.all(operations);
        expect(getEventListeners(retired, "abort")).toHaveLength(0);
        if (cleanup !== "stop") {
          expect(signals).toHaveLength(2);
          expect(signals[1]).not.toBe(retired);
          expect(signals[1]?.aborted).toBe(false);
          await active.replace("third", ["shared"]);
          active.unsubscribe("second");
          expect(signals[1]?.aborted).toBe(false);
          active.unsubscribe("third");
          expect(signals[1]?.aborted).toBe(true);
        }
        for (let index = 0; index < 101; index++) {
          cache.set(String(index), index);
        }
        expect(cache.get("shared")).toBeUndefined();
      } finally {
        held.resolve();
        await Promise.allSettled(operations);
      }
    },
  );

  it("bounds retained subscription keys", () => {
    const params = { sessionKeys: ["watched"], refreshSessionKeys: ["watched"] };
    expect(
      parse({ sessionKeys: Array.from({ length: 201 }, (_, i) => `session-${i}`) }),
    ).toBeNull();
    expect(parse({ sessionKeys: ["x".repeat(513)] })).toBeNull();
    expect(parse({ sessionKeys: ["x".repeat(512)] })).not.toBeNull();
    expect(parse(params)).toEqual({ sessionKeys: ["watched"], refreshSessionKeys: ["watched"] });
    expect(parse({ ...params, refreshSessionKeys: ["other"] })).toBeNull();
  });

  it("polls the watched union once per wake, including after sleep", async () => {
    const clock = createGatewaySchedulerClock();
    const load = vi.fn<(params: LoadParams) => Promise<Snapshot>>(async () => READY);
    const active = start({ load, scheduler: createTestGatewayScheduler(clock.clock) });

    await active.replace("conn-a", ["shared", "only-a"]);
    await active.replace("conn-b", ["shared", "only-b"]);
    expect(load.mock.calls.map(([params]) => params.sessionKey)).toEqual([
      "shared",
      "only-a",
      "only-b",
    ]);

    for (const elapsedMs of [60_000, 300_000]) {
      load.mockClear();
      await clock.advanceBy(elapsedMs);
      expect(
        load.mock.calls
          .map(([params]) => params.sessionKey)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(["only-a", "only-b", "shared"]);
    }
  });

  it("retains caller aliases independently within each audience", async () => {
    const canonicalKey = "agent:main:shared";
    const readSource = createTestSessionPrReadSource();
    const signals = new Map<string, AbortSignal | undefined>();
    const load = vi.fn<NonNullable<Options["load"]>>(async (_params, signal, read) => {
      read.assertCurrent();
      signals.set(read.target.identity, signal);
      return { ...READY, rateLimited: read.target.identity === "private" };
    });
    const active = start({
      load,
      prepareRead: async (connId) => async () => ({
        params: { sessionKey: canonicalKey, agentId: "main" },
        identity: connId === "private" ? "private" : "shared",
        readSource,
        source: null,
      }),
    });
    const aliasPublication = (connId: string, key: string, rateLimited = false) => {
      const [event, payload, connIds] = publication(connId, key, rateLimited);
      return [event, payload, connIds, { sessionKeys: [canonicalKey], agentId: "main" }];
    };

    await active.replace("first", ["short", canonicalKey]);
    await active.replace("second", ["other-short"]);
    await active.replace("private", ["short"]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(broadcastToConnIds.mock.calls).toEqual([
      aliasPublication("first", "short"),
      aliasPublication("first", canonicalKey),
      aliasPublication("second", "other-short"),
      aliasPublication("private", "short", true),
    ]);

    const sharedLifetime = signals.get("shared");
    const privateLifetime = signals.get("private");
    await active.replace("private", ["renamed-short"]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(privateLifetime?.aborted).toBe(false);
    expect(broadcastToConnIds).toHaveBeenLastCalledWith(
      ...aliasPublication("private", "renamed-short", true),
    );
    await active.replace("first", [canonicalKey]);
    active.unsubscribe("second");
    expect(sharedLifetime?.aborted).toBe(false);
    broadcastToConnIds.mockClear();
    await active.replace("first", [canonicalKey], new Set([canonicalKey]));
    expect(broadcastToConnIds.mock.calls).toEqual([aliasPublication("first", canonicalKey)]);
    expect(signals.get("shared")).toBe(sharedLifetime);
    active.unsubscribe("first");
    expect(sharedLifetime?.aborted).toBe(true);
    expect(signals.get("private")?.aborted).toBe(false);
  });

  it("skips a watcher disconnected by an earlier synchronous send", async () => {
    let revision = 0;
    const load = vi.fn(async () => ({ ...READY, rateLimited: revision > 0 }));
    const active = start({ load });
    await active.replace("conn-a", ["shared"]);
    await active.replace("conn-b", ["shared"]);
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => active!.unsubscribe("conn-b"));

    revision++;
    await active.pollNow();

    expectPublication("conn-a", "shared", true);
    broadcastToConnIds.mockClear();
    revision = 0;
    await active.pollNow();
    expectPublication("conn-a", "shared");
  });

  it("shares the four-load limit across connections, hydration, and polling", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const load = vi.fn(
      async () =>
        await new Promise<Snapshot>((resolve) => {
          releases.push(() => resolve(READY));
        }),
    );
    const active = start({ load });
    const sessionKeys = Array.from({ length: 6 }, (_value, index) => `session-${index}`);

    const finishLimitedLoads = async (operation: Promise<unknown>, total = 6) => {
      for (const count of [4, total]) {
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(count));
        for (const release of releases.splice(0)) {
          release();
        }
      }
      await operation;
    };

    await finishLimitedLoads(
      Promise.all([
        active.replace("conn-a", sessionKeys.slice(0, 3)),
        active.replace("conn-b", sessionKeys.slice(3)),
      ]),
    );
    load.mockClear();
    await finishLimitedLoads(
      Promise.all([active.pollNow(), active.replace("conn-c", ["new-1", "new-2"])]),
      8,
    );
  });

  it("discards an orphaned load before hydrating a new watcher", async () => {
    vi.useFakeTimers();
    const retired = createDeferred<Snapshot>();
    const fresh = createDeferred<Snapshot>();
    const load = vi
      .fn()
      .mockImplementationOnce(() => retired.promise)
      .mockImplementationOnce(() => fresh.promise);
    const active = start({ load });
    const initial = active.replace("old", ["session"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const forced = active.replace("old", ["session"], new Set(["session"]));
    active.unsubscribe("old");
    const current = active.replace("new", ["session"]);
    retired.resolve({ ...READY, rateLimited: true });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expectSessions(load, ["session", "session"]);
    fresh.resolve(READY);
    await Promise.all([initial, forced, current]);

    expectPublication("new");
  });

  it("loads agent-scoped global watch keys from the owning agent store", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => READY);
    const active = start({
      load,
    });

    await active.replace("conn-a", ["agent:work:global"]);

    expect(load).toHaveBeenCalledWith(
      { sessionKey: "global", agentId: "work" },
      expect.any(AbortSignal),
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
  });

  it("coalesces forced refresh bursts per session and acknowledges each requester once", async () => {
    const clock = createGatewaySchedulerClock();
    const load = vi.fn(async () => READY);
    const active = start({ load, scheduler: createTestGatewayScheduler(clock.clock) });
    await active.replace("first", ["shared", "independent"]);
    await active.replace("second", ["shared"]);
    await active.replace("first", ["shared", "independent"], new Set(["shared"]));
    load.mockClear();
    broadcastToConnIds.mockClear();

    const queued = [
      active.replace("first", ["shared", "independent"], new Set(["shared"])),
      active.replace("second", ["shared"], new Set(["shared"])),
      active.replace("first", ["shared", "independent"], new Set(["shared"])),
    ];
    await active.replace("first", ["shared", "independent"], new Set(["independent"]));
    await clock.advanceBy(9_999);
    expect(load).toHaveBeenCalledExactlyOnceWith(...loadArgs("independent", true));
    broadcastToConnIds.mockClear();

    await clock.advanceBy(1);
    await Promise.all(queued);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(...loadArgs("shared", true));
    expect(broadcastToConnIds.mock.calls).toEqual(
      ["first", "second"].map((connId) => publication(connId, "shared")),
    );
  });

  it.each(["stop", "disconnect", "empty replace", "reader retirement"])(
    "cancels a coalesced refresh on %s and settles its callers without waiting",
    async (cleanup) => {
      const clock = createGatewaySchedulerClock();
      const load = vi.fn(async () => READY);
      let connected = true;
      const active = start({
        load,
        isConnectionActive: () => connected,
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      await active.replace("requester", ["session"], new Set(["session"]));
      const refresh = active.replace("requester", ["session"], new Set(["session"]));
      broadcastToConnIds.mockClear();
      const operations = [refresh];
      if (cleanup === "stop") {
        operations.push(active.stop());
      } else if (cleanup === "disconnect") {
        active.unsubscribe("requester");
      } else if (cleanup === "reader retirement") {
        connected = false;
        operations.push(active.pollNow());
      } else {
        operations.push(active.replace("requester", []));
      }
      await Promise.all(operations);
      await clock.advanceBy(60_000);

      expect(load).toHaveBeenCalledTimes(1);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it.each(["initial hydration", "poll"] as const)(
    "joins %s and fences queued forced refreshes when stopped",
    async (phase) => {
      const loadStarted = createDeferred();
      const clock = createGatewaySchedulerClock();
      const replacementEntered = createDeferred();
      const heldSnapshot = createDeferred<Snapshot>();
      let blockLoads = phase === "initial hydration";
      const load = vi.fn(async ({ sessionKey }: LoadParams) => {
        if (sessionKey === "barrier") {
          replacementEntered.resolve();
          return READY;
        }
        if (!blockLoads) {
          return READY;
        }
        loadStarted.resolve();
        return await heldSnapshot.promise;
      });
      const subscriptions = start({
        scheduler: createTestGatewayScheduler(clock.clock),
        load,
      });
      const operations: Promise<unknown>[] = [];
      try {
        if (phase === "poll") {
          await subscriptions.replace("conn-a", ["session"]);
          load.mockClear();
          broadcastToConnIds.mockClear();
          blockLoads = true;
        }
        operations.push(
          phase === "initial hydration"
            ? subscriptions.replace("conn-a", ["session"])
            : subscriptions.pollNow(),
        );
        await loadStarted.promise;
        operations.push(
          subscriptions.replace("conn-a", ["session", "barrier"], new Set(["session"])),
        );
        // The second key proves the replacement entered its load queue while the first is held.
        await replacementEntered.promise;
        let stopCompletions = 0;
        for (const stopped of [subscriptions.stop(), subscriptions.stop()]) {
          operations.push(Promise.resolve(stopped).then(() => stopCompletions++));
        }
        await subscriptions.replace("conn-late", ["late"]);
        await subscriptions.pollNow();
        await clock.advanceBy(60_000);
        const completedBeforeRelease = stopCompletions;
        heldSnapshot.resolve(READY);
        await Promise.all(operations);

        expect([
          completedBeforeRelease,
          stopCompletions,
          broadcastToConnIds.mock.calls.length,
        ]).toEqual([0, 2, 0]);
        expectSessions(load, ["session", "barrier"]);
      } finally {
        heldSnapshot.resolve(READY);
        await Promise.allSettled(operations);
        await subscriptions.stop();
      }
    },
  );

  it.each(["poll", "refresh", "handoff"])(
    "keeps a pending result current through a %s membership change",
    async (kind) => {
      vi.useFakeTimers();
      const pending = createDeferred<Snapshot>();
      const load = vi
        .fn()
        .mockResolvedValueOnce(READY)
        .mockImplementationOnce(() => pending.promise);
      if (kind !== "handoff") {
        load.mockResolvedValue(READY);
      }
      const active = start({ load });
      await active.replace("conn-a", ["session"]);
      const pendingLoad =
        kind === "refresh"
          ? active.replace("conn-a", ["session"], new Set(["session"]))
          : active.pollNow();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      if (kind === "handoff") {
        await active.replace("conn-b", ["session"]);
        active.unsubscribe("conn-a");
      } else {
        await active.replace("conn-a", ["session", "other"]);
      }
      broadcastToConnIds.mockClear();
      pending.resolve({ ...READY, rateLimited: true });
      await pendingLoad;

      expectPublication(kind === "handoff" ? "conn-b" : "conn-a", "session", true);
    },
  );

  it("rejects replace-sets from inactive connections before loading", async () => {
    const load = vi.fn(async () => READY);
    const active = start({
      load,
      isConnectionActive: () => false,
    });

    const onAdmitted = vi.fn();
    await active.replace("conn-closed", ["orphan"], undefined, onAdmitted);

    expect(onAdmitted).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("does not publish a superseded replace-set after its load completes", async () => {
    vi.useFakeTimers();
    const { promise: first, resolve: resolveFirst } = createDeferred<Snapshot>();
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
      sessionKey === "old" ? await first : READY,
    );
    const active = start({ load });

    const oldReplace = active.replace("conn-a", ["old", "current"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(...loadArgs("old")));
    await active.replace("conn-a", ["current"]);
    resolveFirst(READY);
    await oldReplace;

    expect(broadcastToConnIds.mock.calls.map((call) => call[1])).toEqual([
      { sessions: { current: { ...READY, status: "ready" } } },
    ]);
  });

  it("delivers a shared cached key after its earlier hydration was superseded", async () => {
    vi.useFakeTimers();
    const { promise: blocked, resolve: resolveBlocked } = createDeferred<Snapshot>();
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
      sessionKey.startsWith("blocked") ? await blocked : READY,
    );
    const active = start({ load });

    const blockedKeys = Array.from({ length: 4 }, (_, index) => `blocked-${index + 1}`);
    const oldReplace = active.replace("conn-a", [...blockedKeys, "shared"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    const replacement = active.replace("conn-a", ["blocked-1"]);
    resolveBlocked(READY);
    await replacement;
    await active.replace("conn-b", ["shared"]);
    broadcastToConnIds.mockClear();

    await active.replace("conn-a", ["shared"]);
    await oldReplace;

    expect(load).toHaveBeenCalledTimes(5);
    expectPublication("conn-a", "shared");
  });

  it("propagates rate-limit and failure states per key", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }): Promise<Snapshot> => {
      if (sessionKey === "limited") {
        return { pullRequests: [], rateLimited: true };
      }
      if (sessionKey === "repository-only") {
        return {
          pullRequests: [],
          repository: { owner: "openclaw", repo: "openclaw" },
          rateLimited: false,
          status: "unavailable",
        };
      }
      throw new Error("GitHub unavailable");
    });
    const active = start({ load });

    await active.replace("conn-a", ["limited", "failed", "repository-only"]);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(3);
    expect(broadcastToConnIds.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        { sessions: { limited: { pullRequests: [], rateLimited: true, status: "rate-limited" } } },
        { sessions: { failed: { pullRequests: [], rateLimited: false, status: "unavailable" } } },
        {
          sessions: {
            "repository-only": {
              pullRequests: [],
              repository: { owner: "openclaw", repo: "openclaw" },
              rateLimited: false,
              status: "unavailable",
            },
          },
        },
      ]),
    );
  });
});
