import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as config from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

function summaryFixture() {
  vi.useFakeTimers();
  const cfg = { agents: { entries: { main: {} } } };
  config.setRuntimeConfigSnapshot(cfg);
  const owner = { key: "agent:main:summary", agentId: "main" };
  const target = (store: string) => ({ ...owner, storePath: `/summary/${store}.sqlite` });
  const initial: SessionEntry = {
    sessionId: "summary-session",
    lifecycleRevision: "original",
    updatedAt: 1,
    label: "first",
  };
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: { first: initial, second: { ...initial, label: "other store" } },
    targetsBySessionKey: new Map(
      ["first", "second"].map((store) => [
        store,
        {
          agentId: owner.agentId,
          storeKey: owner.key,
          storeTarget: target(store),
          entry: initial,
          readSourceEntry: () => undefined,
          resolveSourceKey: (sourceKey: string) => sourceKey,
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
  const publisher = { getSessionRowProjection: () => projection, broadcast };
  const publications: Promise<void>[] = [];
  const publish = (store = "first") => {
    const work = broadcastSessionActivitySummary(target(store), publisher);
    publications.push(work);
    return work;
  };
  onTestFinished(async () => {
    ready.resolve();
    await vi.runAllTimersAsync();
    await Promise.allSettled(publications);
    await drainSessionEventPublications(projection);
    projection.dispose();
    config.clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return { initial, projection, preparation, entered, ready, broadcast, publish };
}

type Fixture = ReturnType<typeof summaryFixture>;
async function enterPreparation(f: Fixture) {
  await vi.advanceTimersByTimeAsync(1_000);
  await f.entered.promise;
}
async function deliver(f: Fixture, ...work: Promise<unknown>[]) {
  f.ready.resolve();
  await vi.runAllTimersAsync();
  await Promise.all(work);
}
function expectRecaps(f: Fixture, ...labels: string[]) {
  expect(f.broadcast.mock.calls.map(([, payload]) => payload)).toMatchObject(
    labels.map((label) => ({ reason: "activity-summary", session: { label } })),
  );
}

it("publishes the latest recap once per window without extending a busy session's deadline", async () => {
  const f = summaryFixture();
  f.ready.resolve();
  for (let index = 0; index < 20; index++) {
    f.projection.setEntry("first", { ...f.initial, label: `recap-${index}` });
    void f.publish();
    await vi.advanceTimersByTimeAsync(75);
    expect(f.broadcast).toHaveBeenCalledTimes(Math.floor((index + 1) / 10));
  }
  expectRecaps(f, "recap-9", "recap-19");
});

it("joins deferred recaps, coalesces the latest row, and admits changes made during delivery", async () => {
  const f = summaryFixture();
  const first = f.publish();
  let drained = false;
  const drain = drainSessionEventPublications(f.projection).then(() => {
    drained = true;
  });
  await enterPreparation(f);
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.broadcast).not.toHaveBeenCalled();
  f.projection.setEntry("first", { ...f.initial, label: "latest" });
  const second = f.publish();
  let following: Promise<void> | undefined;
  f.broadcast.mockImplementationOnce(() => {
    expect(f.broadcast).toHaveBeenCalledOnce();
    f.projection.setEntry("first", { ...f.initial, label: "after delivery" });
    following = f.publish();
  });
  await deliver(f, first, second, drain);
  await following;
  expect(drained).toBe(true);
  expectRecaps(f, "latest", "after delivery");
});

it.each([
  ["session", { sessionId: "replacement" }],
  ["revision", { lifecycleRevision: "reset" }],
  ["store", null],
] as const)("isolates recap ownership by %s", async (_kind, patch) => {
  const f = summaryFixture();
  const first = f.publish();
  await enterPreparation(f);
  const replacement = { ...f.initial, ...patch, label: "replacement" };
  if (patch) {
    f.projection.setEntry("first", replacement);
  }
  const second = f.publish(patch ? "first" : "second");
  await deliver(f, first, second);
  const sessions = patch
    ? [{ sessionId: replacement.sessionId, label: "replacement" }]
    : [{ label: "first" }, { label: "other store" }];
  expect(f.broadcast.mock.calls.map(([, payload]) => payload)).toMatchObject(
    sessions.map((session) => ({ reason: "activity-summary", session })),
  );
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
    await enterPreparation(f);
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
