import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import {
  createTestControlUiSessionPrSubscriptions,
  createTestSessionPrReadSource,
} from "./control-ui-session-pr-subscriptions.test-support.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";
const READY: ControlUiSessionPullRequests = { pullRequests: [], rateLimited: false };
const releases: Array<() => void> = [];
const drains: Array<() => Promise<unknown>> = [];

function drain(
  operations: Promise<unknown>[],
  settled = false,
  before?: () => void | Promise<void>,
) {
  drains.push(async () => {
    if (before) {
      await before();
    }
    return settled ? Promise.allSettled(operations) : Promise.all(operations);
  });
}

function hold<T>(fallback: T) {
  const entered = createDeferred();
  const release = createDeferred<T>();
  const resolve = (value = fallback) => release.resolve(value);
  releases.push(resolve);
  return {
    entered: entered.promise,
    promise: release.promise,
    release: resolve,
    wait: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

function releaseHolds() {
  for (const release of releases.splice(0)) {
    release();
  }
}

function targetFor(sessionKey: string, identity = sessionKey): ControlUiSessionPrTarget {
  return {
    params: { sessionKey, agentId: "main" },
    identity,
    readSource,
    source: null,
  };
}

let running: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;
let broadcastToConnIds: ReturnType<typeof vi.fn<Options["broadcastToConnIds"]>>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let readSource: ReturnType<typeof createTestSessionPrReadSource>;
type Options = Parameters<typeof createTestControlUiSessionPrSubscriptions>[0];

function start(options: Omit<Options, "scheduler" | "broadcastToConnIds">) {
  running = createTestControlUiSessionPrSubscriptions({
    scheduler,
    broadcastToConnIds,
    ...options,
  });
  return running;
}

beforeEach(({ onTestFinished }) => {
  readSource = createTestSessionPrReadSource(onTestFinished);
  broadcastToConnIds = vi.fn<Options["broadcastToConnIds"]>();
});
afterEach(async () => {
  releaseHolds();
  try {
    for (const settle of drains.splice(0)) {
      await settle();
    }
  } finally {
    await running?.stop();
    await scheduler.stop();
    running = undefined;
    vi.useRealTimers();
  }
});

describe("recipient publication lifetimes", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let target: ControlUiSessionPrTarget;

  beforeEach(() => {
    target = targetFor("shared");
    clock = createGatewaySchedulerClock(Date.now());
    scheduler = createTestGatewayScheduler(clock.clock);
    vi.useFakeTimers();
  });

  const changed: ControlUiSessionPullRequests = { ...READY, rateLimited: true };
  function publication(connId: string, key = "shared", rateLimited = true) {
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

  async function watch(active: NonNullable<typeof running>, ...connections: string[]) {
    for (const connection of connections) {
      await active.replace(connection, ["shared"]);
    }
    broadcastToConnIds.mockClear();
  }

  function expectPublications(connections: string[], key = "shared", rateLimited = true) {
    expect(broadcastToConnIds.mock.calls).toEqual(
      connections.map((id) => publication(id, key, rateLimited)),
    );
  }

  it.each(["selection", "grant"] as const)(
    "continues delivery when a recipient's prepared %s changes",
    async (boundary) => {
      const held = hold(undefined);
      const access = new AbortController();
      let generation = 0;
      let holdRecipient = false;
      let snapshot = READY;
      const active = start({
        load: async () => snapshot,
        prepareRead: async (connId) => async () => {
          if (boundary === "grant" && connId === "recipient" && access.signal.aborted) {
            return undefined;
          }
          const captured = generation;
          const prepared = {
            ...target,
            assertCurrent: () => {
              if (connId === "recipient" && holdRecipient) {
                throw new Error("Recipient preparation pending");
              }
              if (boundary === "selection" && captured !== generation) {
                throw new Error("Prepared selection changed");
              }
              if (boundary === "grant" && connId === "recipient") {
                access.signal.throwIfAborted();
              }
            },
          };
          if (connId === "recipient" && holdRecipient) {
            holdRecipient = false;
            await held.wait();
          }
          return prepared;
        },
      });
      await watch(active, "first", "recipient", ...(boundary === "grant" ? ["last"] : []));
      broadcastToConnIds.mockImplementationOnce(() => {
        holdRecipient = true;
      });
      snapshot = changed;
      const poll = active.pollNow();
      drain([poll]);
      await held.entered;
      generation++;
      access.abort(new Error("Recipient access retired"));
      held.release();
      await poll;
      if (boundary === "selection") {
        expectPublications(["first"]);
        await active.pollNow();
        expectPublications(["first", "recipient"]);
        await active.pollNow();
        expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      } else {
        expectPublications(["first", "last"]);
        broadcastToConnIds.mockClear();
        await active.pollNow();
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      }
    },
  );

  it("acknowledges a forced result equal to the normal poll queued before it", async () => {
    const normal = hold(undefined);
    const forced = hold(undefined);
    let holdNormal = false;
    const active = start({
      load: async ({ refresh }) => {
        if (refresh) {
          await forced.wait();
          return changed;
        }
        if (holdNormal) {
          await normal.wait();
          return changed;
        }
        return READY;
      },
    });
    await watch(active, "first", "recipient");
    holdNormal = true;
    const poll = active.pollNow();
    await normal.entered;
    const refresh = active.replace("first", ["shared"], new Set(["shared"]));
    drain([poll, refresh]);
    normal.release();
    await forced.entered;
    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    forced.release();
    await Promise.all([poll, refresh]);
    expectPublications(["first", "recipient", "first"]);
  });

  it("acknowledges a refresh admitted after that viewer received the in-flight result", async () => {
    const held = hold(undefined);
    let holdRecipient = false;
    const load = vi.fn(async ({ refresh }: { refresh?: boolean }) => (refresh ? changed : READY));
    const active = start({
      load,
      prepareRead: async (connId) => async () => {
        if (connId === "recipient" && holdRecipient) {
          holdRecipient = false;
          await held.wait();
        }
        return target;
      },
    });
    await watch(active, "first", "recipient");
    load.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    const first = active.replace("first", ["shared"], new Set(["shared"]));
    const operations = [first];
    drain(operations);
    await held.entered;
    operations.push(active.replace("first", ["shared"], new Set(["shared"])));
    await vi.advanceTimersByTimeAsync(0);
    held.release();
    await Promise.all(operations);
    expect(load).toHaveBeenCalledTimes(1);
    expectPublications(["first", "recipient", "first"]);
  });

  it("keeps a pending replacement when its last old watch loses visibility", async () => {
    const held = hold(undefined);
    const retired = createDeferred();
    let oldVisible = true;
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }, signal?: AbortSignal) => {
      if (sessionKey === "old") {
        signal?.addEventListener("abort", () => retired.resolve(), { once: true });
      }
      return READY;
    });
    const active = start({
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "new") {
          await held.wait();
        }
        return async () =>
          session.sessionKey === "old" && !oldVisible ? undefined : targetFor(session.sessionKey);
      },
    });
    await active.replace("same", ["old"]);
    broadcastToConnIds.mockClear();
    const replacement = active.replace("same", ["new"]);
    await held.entered;
    oldVisible = false;
    const poll = active.pollNow();
    drain([replacement, poll]);
    await retired.promise;
    held.release();
    await Promise.all([replacement, poll]);
    expectPublications(["same"], "new", false);
  });

  it("does not let a superseded preparation overwrite a current refresh request", async () => {
    const oldRead = hold(undefined);
    const blocked = hold(undefined);
    const loading = hold(undefined);
    let holdOld = false;
    const load = vi.fn(async ({ refresh }: { refresh?: boolean }) => {
      if (refresh) {
        await loading.wait();
      }
      return READY;
    });
    const active = start({
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "blocked") {
          await blocked.wait();
        }
        return async () => {
          if (holdOld) {
            holdOld = false;
            await oldRead.wait();
          }
          return target;
        };
      },
    });
    await watch(active, "same");
    load.mockClear();
    holdOld = true;
    const old = active.replace("same", ["shared", "blocked"], new Set(["shared"]));
    await oldRead.entered;
    const current = active.replace("same", ["shared"], new Set(["shared"]));
    drain([old, current], false, () => clock.advanceBy(10_000));
    await loading.entered;
    oldRead.release();
    await blocked.entered;
    loading.release();
    await current;
    expectPublications(["same"], "shared", false);
    blocked.release();
    await old;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not revive a retired admission after its connection ID is reused", async () => {
    const held = hold(undefined);
    const load = vi.fn(async () => READY);
    const active = start({
      load,
      prepareRead: async (_connId, session) => {
        if (session.sessionKey === "retired") {
          await held.wait();
        }
        return async () => targetFor(session.sessionKey);
      },
    });
    const retired = active.replace("reused", ["retired"]);
    drain([retired]);
    await held.entered;
    active.unsubscribe("reused");
    await active.replace("reused", ["current"]);
    held.release();
    await retired;
    expect(load).toHaveBeenCalledTimes(1);
    expectPublications(["reused"], "current", false);
  });

  it.each(["grant", "all"] as const)(
    "keeps pending shared reads authorized by surviving viewers after %s retirement",
    async (retirement) => {
      const held = hold(undefined);
      const access = { survivor: new AbortController(), departing: new AbortController() };
      let holdLoad = false;
      let authorized = false;
      const active = start({
        prepareRead: async (connId) => {
          const grant = connId === "survivor" ? access.survivor : access.departing;
          const preparedTarget = {
            ...target,
            assertCurrent: () => grant.signal.throwIfAborted(),
          };
          return async () => (grant.signal.aborted ? undefined : preparedTarget);
        },
        load: async (_params, _signal, read) => {
          if (!holdLoad) {
            return READY;
          }
          await held.wait();
          read.assertCurrent();
          authorized = true;
          return changed;
        },
      });
      await watch(active, "survivor", "departing");
      holdLoad = true;
      const poll = active.pollNow();
      drain([poll]);
      await held.entered;
      access.departing.abort(new Error("Grant retired"));
      if (retirement === "all") {
        access.survivor.abort(new Error("Grant retired"));
      }
      held.release();
      await poll;
      expect(authorized).toBe(retirement !== "all");
      if (retirement === "all") {
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } else {
        expectPublications(["survivor"]);
      }
    },
  );

  it("checks the recipient's prepared authority when another watcher joins before send", async () => {
    const access = new AbortController();
    let holdRecipient = false;
    const recipientTarget = {
      ...target,
      assertCurrent: () => {
        if (holdRecipient) {
          throw new Error("Recipient preparation pending");
        }
        access.signal.throwIfAborted();
      },
    };
    const recipient = hold(recipientTarget);
    const joining = hold(target);
    let snapshot = READY;
    const active = start({
      load: async () => snapshot,
      prepareRead: async (connId) => () => {
        if (connId === "joining") {
          return joining.wait();
        }
        if (connId === "recipient") {
          if (holdRecipient) {
            holdRecipient = false;
            return recipient.wait();
          }
          return Promise.resolve(access.signal.aborted ? undefined : recipientTarget);
        }
        return Promise.resolve(target);
      },
    });
    await watch(active, "first", "recipient");
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    const operations: Promise<unknown>[] = [poll];
    drain(operations, true);
    await recipient.entered;
    operations.push(active.replace("joining", ["shared"]));
    await joining.entered;
    access.abort(new Error("Recipient access retired"));
    // The recipient finishes preparation first; admission then updates the shared
    // target before the recipient's queued send can resume.
    recipient.release();
    joining.release();
    await Promise.all(operations);

    expectPublications(["first", "joining"]);
  });

  it("keeps queued facts paired with their original read guard after a prepared update", async () => {
    target = { ...target, ownGitHubProfileId: "own-profile" };
    const original = new AbortController();
    let guard = () => original.signal.throwIfAborted();
    let snapshot = READY;
    let holdRecipient = false;
    const recipient = hold(target);
    const active = start({
      load: async (_params, _signal, read) => {
        read.retainReadAuthority?.(guard);
        return snapshot;
      },
      prepareRead: async (connId) => async () => {
        if (connId === "recipient" && holdRecipient) {
          holdRecipient = false;
          return recipient.wait();
        }
        return target;
      },
    });
    await watch(active, "first", "recipient");
    active.readPrepared(target, () => false);
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    drain([poll], true);
    await recipient.entered;
    original.abort(new Error("Selected read identity retired"));
    const replacement = new AbortController();
    guard = () => replacement.signal.throwIfAborted();
    snapshot = {
      ...READY,
      branch: { owner: "example", repo: "repository", branch: "replacement" },
    };
    await active.read(target, () => {});
    recipient.release();
    await poll;

    expect(broadcastToConnIds.mock.calls).toEqual([
      publication("first"),
      ["sessions.changed", { reason: "profile-identity" }, new Set(["recipient"])],
    ]);
    expect(active.readPrepared(target, () => false)?.branch).toEqual(snapshot.branch);
  });

  it.each(["pending", "prepared"] as const)(
    "does not revive a removed watcher whose delivery read is %s",
    async (boundary) => {
      const held = hold(target);
      let holdRecipient = false;
      let snapshot = READY;
      let cacheSignal: AbortSignal | undefined;
      const active = start({
        load: async (_params, signal) => {
          cacheSignal = signal;
          return snapshot;
        },
        prepareRead: async (connId) => () => {
          if (connId === "removed" && holdRecipient) {
            holdRecipient = false;
            return held.wait();
          }
          return Promise.resolve(target);
        },
      });
      await watch(active, "first", "removed");
      broadcastToConnIds.mockImplementationOnce(() => {
        holdRecipient = true;
      });
      snapshot = changed;
      const poll = active.pollNow();
      drain([poll]);
      await held.entered;
      if (boundary === "pending") {
        active.unsubscribe("removed");
      }
      held.release();
      if (boundary === "prepared") {
        // The owner's earlier promise reaction installs the prepared target;
        // retire membership before the queued publication continuation runs.
        await held.promise;
        active.unsubscribe("removed");
      }
      await poll;

      expectPublications(["first"]);
      active.unsubscribe("first");
      expect(cacheSignal?.aborted).toBe(true);
    },
  );
});

describe("one-shot session PR reads", () => {
  let target: ControlUiSessionPrTarget;
  beforeEach(() => {
    target = targetFor("agent:main:change", "original-session");
    scheduler = createTestGatewayScheduler();
  });

  it("keeps a forced watcher snapshot when an older prepared read settles later", async ({
    signal,
  }) => {
    const held = hold(undefined);
    const selected = { ...target, source: "/synthetic/repository" };
    const owner = start({
      prepareRead: async () => async () => selected,
      load: async ({ refresh }) => {
        if (!refresh) {
          await held.wait();
        }
        return {
          ...READY,
          repository: { owner: "synthetic", repo: refresh ? "fresh" : "old" },
        };
      },
    });
    expect(owner.readPrepared(selected)).toBeUndefined();
    const reading = owner.read(selected, () => {});
    drain([reading]);
    await withinTest(held.entered, signal);
    const { sessionKey } = selected.params;
    await withinTest(owner.replace("viewer", [sessionKey], new Set([sessionKey])), signal);
    expect(owner.readPrepared(selected)?.repository?.repo).toBe("fresh");
    held.release();
    await withinTest(reading, signal);
    expect(owner.readPrepared(selected)?.repository?.repo).toBe("fresh");
  });

  it.each(["caller", "session", "owner"] as const)(
    "does not disclose an in-flight result after the %s retires",
    async (retired) => {
      const held = hold(undefined);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Read authority retired");
        }
      };
      const owner = start({
        load: async () => {
          await held.wait();
          return READY;
        },
      });
      const reading = owner.read(
        { ...target, ...(retired === "session" ? { assertCurrent } : {}) },
        retired === "caller" ? assertCurrent : () => {},
        "publication",
      );
      const rejected = expect(reading).rejects.toThrow(/retired|closed/);
      await held.entered;
      current = false;
      let stopped = false;
      const stopping =
        retired === "owner"
          ? owner.stop().then(() => {
              stopped = true;
            })
          : undefined;
      expect(stopped).toBe(false);
      held.release();
      await rejected;
      await stopping;
      if (retired === "owner") {
        expect(stopped).toBe(true);
        expect(() => owner?.read(target, () => {})).toThrow("closed");
      }
    },
  );
});
