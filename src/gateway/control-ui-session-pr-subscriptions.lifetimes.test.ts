import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";
const READY: ControlUiSessionPullRequests = { pullRequests: [], rateLimited: false };
let active: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;

afterEach(async () => {
  await active?.stop();
  active = undefined;
  vi.useRealTimers();
});

describe("recipient publication lifetimes", () => {
  const target: ControlUiSessionPrTarget = {
    params: { sessionKey: "shared", agentId: "main" },
    identity: "shared",
    readSource: { agentId: "main", path: "unused" },
    source: null,
  };
  const changed: ControlUiSessionPullRequests = { ...READY, rateLimited: true };
  const changedSessions = {
    shared: { ...changed, status: "rate-limited" },
  };

  it.each(["disconnect", "replace with another key", "replace with the same key"] as const)(
    "tracks shared cache ownership during %s of a preparing watcher",
    async (action) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const held = createDeferred<ControlUiSessionPrTarget>();
      let holdPreparation = true;
      let settled = false;
      const load = vi.fn(
        async (_params: ControlUiSessionPullRequestsParams, _signal: AbortSignal | undefined) =>
          READY,
      );
      active = createTestControlUiSessionPrSubscriptions({
        broadcastToConnIds: vi.fn(),
        load,
        prepareRead: async (connId, session) => () => {
          if (connId === "preparing" && holdPreparation) {
            holdPreparation = false;
            entered.resolve();
            return held.promise;
          }
          return Promise.resolve({
            ...target,
            params: { sessionKey: session.sessionKey, agentId: "main" },
            identity: session.sessionKey,
          });
        },
      });
      await active.replace("first", ["shared"]);
      const original = load.mock.calls[0]![1];
      const preparing = active.replace("preparing", ["shared"]).then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        active.unsubscribe("first");
        expect(original?.aborted).toBe(false);
        if (action === "disconnect") {
          active.unsubscribe("preparing");
        } else {
          await active.replace("preparing", [
            action === "replace with the same key" ? "shared" : "other",
          ]);
        }
        const retained = action === "replace with the same key";
        expect(original?.aborted).toBe(!retained);
        expect(settled).toBe(false);

        await active.replace("next", ["shared"]);
        const sharedLoads = load.mock.calls.filter(([params]) => params.sessionKey === "shared");
        expect(sharedLoads).toHaveLength(retained ? 1 : 2);
        if (!retained) {
          expect(sharedLoads[1]![1]).not.toBe(original);
          expect(sharedLoads[1]![1]?.aborted).toBe(false);
        }
        held.resolve(target);
        await preparing;
        expect(settled).toBe(true);
      } finally {
        held.resolve(target);
        await preparing;
      }
    },
  );

  it("retries an unchanged snapshot missed during recipient preparation without duplicating delivery", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const release = createDeferred();
    let generation = 0;
    let holdRecipient = false;
    let snapshot = READY;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async () => snapshot,
      prepareRead: async (connId) => async () => {
        const captured = generation;
        const prepared = {
          ...target,
          assertCurrent: () => {
            if (captured !== generation) {
              throw new Error("Prepared selection changed");
            }
          },
        };
        if (connId === "recipient" && holdRecipient) {
          holdRecipient = false;
          entered.resolve();
          await release.promise;
        }
        return prepared;
      },
    });
    await active.replace("first", ["shared"]);
    await active.replace("recipient", ["shared"]);
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    try {
      await entered.promise;
      generation++;
      release.resolve();
      await poll;
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: changedSessions },
        new Set(["first"]),
        { sessionKeys: ["shared"], agentId: "main" },
      );

      await active.pollNow();
      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "recipient"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
      await active.pollNow();
      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await poll;
    }
  });

  it("acknowledges a forced result equal to the normal poll queued before it", async () => {
    vi.useFakeTimers();
    const normalEntered = createDeferred();
    const normalRelease = createDeferred();
    const forcedEntered = createDeferred();
    const forcedRelease = createDeferred();
    const admitted = createDeferred();
    let holdNormal = false;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async ({ refresh }) => {
        if (refresh) {
          forcedEntered.resolve();
          await forcedRelease.promise;
          return changed;
        }
        if (holdNormal) {
          normalEntered.resolve();
          await normalRelease.promise;
          return changed;
        }
        return READY;
      },
    });
    await active.replace("first", ["shared"]);
    await active.replace("recipient", ["shared"]);
    broadcastToConnIds.mockClear();
    holdNormal = true;
    const poll = active.pollNow();
    await normalEntered.promise;
    const refresh = active.replace("first", ["shared"], new Set(["shared"]), admitted.resolve);
    try {
      await admitted.promise;
      normalRelease.resolve();
      await forcedEntered.promise;
      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      forcedRelease.resolve();
      await Promise.all([poll, refresh]);
      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "recipient", "first"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
    } finally {
      normalRelease.resolve();
      forcedRelease.resolve();
      await Promise.all([poll, refresh]);
    }
  });

  it("acknowledges a refresh admitted after that viewer received the in-flight result", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const release = createDeferred();
    const admitted = createDeferred();
    let holdRecipient = false;
    const load = vi.fn(async ({ refresh }: { refresh?: boolean }) => (refresh ? changed : READY));
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load,
      prepareRead: async (connId) => async () => {
        if (connId === "recipient" && holdRecipient) {
          holdRecipient = false;
          entered.resolve();
          await release.promise;
        }
        return target;
      },
    });
    await active.replace("first", ["shared"]);
    await active.replace("recipient", ["shared"]);
    broadcastToConnIds.mockClear();
    load.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    const first = active.replace("first", ["shared"], new Set(["shared"]));
    const operations = [first];
    try {
      await entered.promise;
      operations.push(active.replace("first", ["shared"], new Set(["shared"]), admitted.resolve));
      await admitted.promise;
      await vi.advanceTimersByTimeAsync(0);
      release.resolve();
      await Promise.all(operations);
      expect(load).toHaveBeenCalledTimes(1);
      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "recipient", "first"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
    } finally {
      release.resolve();
      await Promise.all(operations);
    }
  });

  it("keeps a pending replacement when its last old watch loses visibility", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const release = createDeferred();
    const retired = createDeferred();
    let oldVisible = true;
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }, signal?: AbortSignal) => {
      if (sessionKey === "old") {
        signal?.addEventListener("abort", () => retired.resolve(), { once: true });
      }
      return READY;
    });
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "new") {
          entered.resolve();
          await release.promise;
        }
        return async () =>
          session.sessionKey === "old" && !oldVisible
            ? undefined
            : {
                ...target,
                params: { ...target.params, sessionKey: session.sessionKey },
                identity: session.sessionKey,
              };
      },
    });
    await active.replace("same", ["old"]);
    broadcastToConnIds.mockClear();
    const replacement = active.replace("same", ["new"]);
    await entered.promise;
    oldVisible = false;
    const poll = active.pollNow();
    try {
      await retired.promise;
      release.resolve();
      await Promise.all([replacement, poll]);
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: { new: { ...READY, status: "ready" } } },
        new Set(["same"]),
        { sessionKeys: ["new"], agentId: "main" },
      );
    } finally {
      release.resolve();
      await Promise.all([replacement, poll]);
    }
  });

  it("does not let a superseded preparation overwrite a current refresh request", async () => {
    vi.useFakeTimers();
    const oldEntered = createDeferred();
    const oldRelease = createDeferred();
    const blockedEntered = createDeferred();
    const blockedRelease = createDeferred();
    const loadEntered = createDeferred();
    const loadRelease = createDeferred();
    let holdOld = false;
    const load = vi.fn(async ({ refresh }: { refresh?: boolean }) => {
      if (refresh) {
        loadEntered.resolve();
        await loadRelease.promise;
      }
      return READY;
    });
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "blocked") {
          blockedEntered.resolve();
          await blockedRelease.promise;
        }
        return async () => {
          if (holdOld) {
            holdOld = false;
            oldEntered.resolve();
            await oldRelease.promise;
          }
          return target;
        };
      },
    });
    await active.replace("same", ["shared"]);
    broadcastToConnIds.mockClear();
    load.mockClear();
    holdOld = true;
    const old = active.replace("same", ["shared", "blocked"], new Set(["shared"]));
    await oldEntered.promise;
    const current = active.replace("same", ["shared"], new Set(["shared"]));
    try {
      await loadEntered.promise;
      oldRelease.resolve();
      await blockedEntered.promise;
      loadRelease.resolve();
      await current;
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: { shared: { ...READY, status: "ready" } } },
        new Set(["same"]),
        { sessionKeys: ["shared"], agentId: "main" },
      );
      blockedRelease.resolve();
      await old;
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      oldRelease.resolve();
      blockedRelease.resolve();
      loadRelease.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([old, current]);
    }
  });

  it("does not revive a retired admission after its connection ID is reused", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const held = createDeferred();
    const load = vi.fn(async () => READY);
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "retired") {
          entered.resolve();
          await held.promise;
        }
        return async () => ({
          ...target,
          params: { ...target.params, sessionKey: session.sessionKey },
          identity: session.sessionKey,
        });
      },
    });
    const retired = active.replace("reused", ["retired"]);
    try {
      await entered.promise;
      active.unsubscribe("reused");
      await active.replace("reused", ["current"]);
      held.resolve();
      await retired;
      expect(load).toHaveBeenCalledTimes(1);
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: { current: { ...READY, status: "ready" } } },
        new Set(["reused"]),
        { sessionKeys: ["current"], agentId: "main" },
      );
    } finally {
      held.resolve();
      await retired;
    }
  });

  it.each(["disconnect", "grant", "all"] as const)(
    "keeps pending shared reads authorized by surviving viewers after %s retirement",
    async (retirement) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const held = createDeferred();
      const connected = new Set(["survivor", "departing"]);
      const access = { survivor: new AbortController(), departing: new AbortController() };
      const broadcastToConnIds = vi.fn();
      let holdLoad = false;
      let authorized = false;
      active = createTestControlUiSessionPrSubscriptions({
        broadcastToConnIds,
        isConnectionActive: (connId) => connected.has(connId),
        prepareRead: async (connId) => {
          const grant = connId === "survivor" ? access.survivor : access.departing;
          const preparedTarget = {
            ...target,
            assertCurrent: () => {
              if (!connected.has(connId)) {
                throw new Error("Connection retired");
              }
              grant.signal.throwIfAborted();
            },
          };
          return async () =>
            connected.has(connId) && !grant.signal.aborted ? preparedTarget : undefined;
        },
        load: async (_params, _signal, read) => {
          if (!holdLoad) {
            return READY;
          }
          entered.resolve();
          await held.promise;
          read.assertCurrent();
          authorized = true;
          return changed;
        },
      });
      await active.replace("survivor", ["shared"]);
      await active.replace("departing", ["shared"]);
      broadcastToConnIds.mockClear();
      holdLoad = true;
      const poll = active.pollNow();
      try {
        await entered.promise;
        if (retirement === "disconnect") {
          connected.delete("departing");
          active.unsubscribe("departing");
        } else {
          access.departing.abort(new Error("Grant retired"));
          if (retirement === "all") {
            access.survivor.abort(new Error("Grant retired"));
          }
        }
        held.resolve();
        await poll;
        expect(authorized).toBe(retirement !== "all");
        if (retirement === "all") {
          expect(broadcastToConnIds).not.toHaveBeenCalled();
        } else {
          expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            CHANGED_EVENT,
            { sessions: changedSessions },
            new Set(["survivor"]),
            { sessionKeys: ["shared"], agentId: "main" },
          );
        }
      } finally {
        held.resolve();
        await poll;
      }
    },
  );

  it("checks the recipient's prepared authority when another watcher joins before send", async () => {
    vi.useFakeTimers();
    const recipientEntered = createDeferred();
    const recipientRead = createDeferred<ControlUiSessionPrTarget>();
    const joiningEntered = createDeferred();
    const joiningRead = createDeferred<ControlUiSessionPrTarget>();
    const access = new AbortController();
    const recipientTarget = { ...target, assertCurrent: () => access.signal.throwIfAborted() };
    let holdRecipient = false;
    let snapshot = READY;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async () => snapshot,
      prepareRead: async (connId) => () => {
        if (connId === "joining") {
          joiningEntered.resolve();
          return joiningRead.promise;
        }
        if (connId === "recipient") {
          if (holdRecipient) {
            holdRecipient = false;
            recipientEntered.resolve();
            return recipientRead.promise;
          }
          return Promise.resolve(access.signal.aborted ? undefined : recipientTarget);
        }
        return Promise.resolve(target);
      },
    });
    await active.replace("first", ["shared"]);
    await active.replace("recipient", ["shared"]);
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    const operations: Promise<unknown>[] = [poll];
    try {
      await recipientEntered.promise;
      operations.push(active.replace("joining", ["shared"]));
      await joiningEntered.promise;
      access.abort(new Error("Recipient access retired"));
      // The recipient finishes preparation first; admission then updates the shared
      // target before the recipient's queued send can resume.
      recipientRead.resolve(recipientTarget);
      joiningRead.resolve(target);
      await Promise.all(operations);

      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "joining"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
    } finally {
      recipientRead.resolve(recipientTarget);
      joiningRead.resolve(target);
      await Promise.allSettled(operations);
    }
  });

  it.each(["pending", "prepared"] as const)(
    "does not revive a removed watcher whose delivery read is %s",
    async (boundary) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const held = createDeferred<ControlUiSessionPrTarget>();
      let holdRecipient = false;
      let snapshot = READY;
      let cacheSignal: AbortSignal | undefined;
      const broadcastToConnIds = vi.fn();
      active = createTestControlUiSessionPrSubscriptions({
        broadcastToConnIds,
        load: async (_params, signal) => {
          cacheSignal = signal;
          return snapshot;
        },
        prepareRead: async (connId) => () => {
          if (connId === "removed" && holdRecipient) {
            holdRecipient = false;
            entered.resolve();
            return held.promise;
          }
          return Promise.resolve(target);
        },
      });
      await active.replace("first", ["shared"]);
      await active.replace("removed", ["shared"]);
      broadcastToConnIds.mockClear();
      broadcastToConnIds.mockImplementationOnce(() => {
        holdRecipient = true;
      });
      snapshot = changed;
      const poll = active.pollNow();
      try {
        await entered.promise;
        if (boundary === "pending") {
          active.unsubscribe("removed");
        }
        held.resolve(target);
        if (boundary === "prepared") {
          // The owner's earlier promise reaction installs the prepared target;
          // retire membership before the queued publication continuation runs.
          await held.promise;
          active.unsubscribe("removed");
        }
        await poll;

        expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set(["first"]),
          { sessionKeys: ["shared"], agentId: "main" },
        );
        active.unsubscribe("first");
        expect(cacheSignal?.aborted).toBe(true);
      } finally {
        held.resolve(target);
        await poll;
      }
    },
  );

  it("continues to later recipients after one prepared authority rejects the shared snapshot", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const held = createDeferred<ControlUiSessionPrTarget>();
    const access = new AbortController();
    const rejectedTarget = { ...target, assertCurrent: () => access.signal.throwIfAborted() };
    let holdRecipient = false;
    let snapshot = READY;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async () => snapshot,
      prepareRead: async (connId) => () => {
        if (connId === "rejected") {
          if (holdRecipient) {
            holdRecipient = false;
            entered.resolve();
            return held.promise;
          }
          return Promise.resolve(access.signal.aborted ? undefined : rejectedTarget);
        }
        return Promise.resolve(target);
      },
    });
    for (const connId of ["first", "rejected", "last"]) {
      await active.replace(connId, ["shared"]);
    }
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    try {
      await entered.promise;
      access.abort(new Error("Recipient access retired"));
      held.resolve(rejectedTarget);
      await poll;

      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "last"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
      broadcastToConnIds.mockClear();
      await active.pollNow();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      held.resolve(rejectedTarget);
      await poll;
    }
  });
});
