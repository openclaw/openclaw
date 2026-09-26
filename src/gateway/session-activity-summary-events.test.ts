import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

function summaryFixture() {
  vi.useFakeTimers();
  const target = {
    key: "agent:main:summary",
    agentId: "main",
    storePath: "/summary/first.sqlite",
  };
  const other = { ...target, storePath: "/summary/second.sqlite" };
  const initial: SessionEntry = {
    sessionId: "summary-session",
    lifecycleRevision: "original",
    updatedAt: 1,
    label: "first",
  };
  const projection = createSessionRowProjectionFixture({
    cfg: { agents: { entries: { main: {} } } },
    store: { first: initial, second: { ...initial, label: "other store" } },
    targetsBySessionKey: new Map(
      [target, other].map((row, index) => [
        index === 0 ? "first" : "second",
        {
          agentId: row.agentId,
          storeKey: row.key,
          storeTarget: { agentId: row.agentId, storePath: row.storePath },
          entry: initial,
          readSourceEntry: () => undefined,
          resolveSourceKey: (key: string) => key,
        },
      ]),
    ),
  });
  const entered = createDeferred();
  const ready = createDeferred();
  const prepare = projection.withPreparedExactRows.bind(projection);
  const preparation = vi
    .spyOn(projection, "withPreparedExactRows")
    .mockImplementation(async (queries, consume, options) => {
      entered.resolve();
      await ready.promise;
      return prepare(queries, consume, options);
    });
  const broadcast = vi.fn<GatewayBroadcastFn>();
  const publications: Promise<void>[] = [];
  const publish = (selected = target) => {
    const work = broadcastSessionActivitySummary(selected, {
      getSessionRowProjection: () => projection,
      broadcast,
    });
    publications.push(work);
    return work;
  };
  onTestFinished(async () => {
    ready.resolve();
    await vi.runAllTimersAsync();
    await Promise.allSettled(publications);
    await drainSessionEventPublications(projection);
    projection.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return { target, other, initial, projection, preparation, entered, ready, broadcast, publish };
}

it("joins a recap admitted before its deferred preparation starts", async () => {
  const f = summaryFixture();
  const publication = f.publish();
  let drained = false;
  const drain = drainSessionEventPublications(f.projection).then(() => {
    drained = true;
  });
  await f.entered.promise;
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.broadcast).not.toHaveBeenCalled();
  f.ready.resolve();
  await vi.runAllTimersAsync();
  await Promise.all([publication, drain]);
  expect(drained).toBe(true);
  expect(f.broadcast).toHaveBeenCalledOnce();
});

it("coalesces pending recaps to the latest row and admits changes made during delivery", async () => {
  const f = summaryFixture();
  const first = f.publish();
  await f.entered.promise;
  f.projection.setEntry("first", { ...f.initial, label: "latest" });
  const second = f.publish();
  let following: Promise<void> | undefined;
  f.broadcast.mockImplementationOnce(() => {
    f.projection.setEntry("first", { ...f.initial, label: "after delivery" });
    following = f.publish();
  });
  f.ready.resolve();
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  await following;
  expect(f.broadcast.mock.calls.map(([, payload]) => payload)).toMatchObject([
    { reason: "activity-summary", session: { label: "latest" } },
    { reason: "activity-summary", session: { label: "after delivery" } },
  ]);
});

it.each([
  { sessionId: "replacement", lifecycleRevision: "original" },
  { sessionId: "summary-session", lifecycleRevision: "reset" },
])("keeps replacement recap ownership for $sessionId/$lifecycleRevision", async (replacement) => {
  const f = summaryFixture();
  const first = f.publish();
  await f.entered.promise;
  f.projection.setEntry("first", { ...f.initial, ...replacement, label: "replacement" });
  const second = f.publish();
  f.ready.resolve();
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(f.broadcast).toHaveBeenCalledOnce();
  expect(f.broadcast.mock.calls[0]?.[1]).toMatchObject({
    reason: "activity-summary",
    session: { sessionId: replacement.sessionId, label: "replacement" },
  });
});

it("keeps identically named rows in different physical stores independent", async () => {
  const f = summaryFixture();
  const first = f.publish();
  await f.entered.promise;
  const second = f.publish(f.other);
  f.ready.resolve();
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(f.broadcast.mock.calls.map(([, payload]) => payload)).toMatchObject([
    { session: { label: "first" } },
    { session: { label: "other store" } },
  ]);
});

it.each(["preparation", "publication"])(
  "rejects every coalesced waiter after %s fails and allows another recap",
  async (failureStage) => {
    const f = summaryFixture();
    const failure = new Error("summary publication failed");
    if (failureStage === "preparation") {
      f.preparation.mockImplementationOnce(async () => {
        f.entered.resolve();
        await f.ready.promise;
        throw failure;
      });
    } else {
      f.broadcast.mockImplementationOnce(() => {
        throw failure;
      });
    }
    const first = f.publish();
    await f.entered.promise;
    const second = f.publish();
    const settled = Promise.allSettled([first, second]);
    f.ready.resolve();
    await vi.runAllTimersAsync();
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    const retry = f.publish();
    await vi.runAllTimersAsync();
    await retry;
    expect(f.broadcast).toHaveBeenCalledTimes(failureStage === "preparation" ? 1 : 2);
    expect(f.broadcast.mock.calls.at(-1)?.[1]).toMatchObject({
      reason: "activity-summary",
      session: { label: "first" },
    });
  },
);
