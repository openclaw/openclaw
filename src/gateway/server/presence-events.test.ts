import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createPresencePublisher } from "./presence-events.js";

function setup(prepare: () => Promise<void> | undefined = () => undefined) {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const broadcast = vi.fn();
  let version = 0;
  const publisher = createPresencePublisher({
    scheduler,
    broadcast,
    incrementPresenceVersion: () => ++version,
    getHealthVersion: () => 1,
    prepare,
  });
  onTestFinished(async () => {
    publisher.stop();
    await scheduler.stop();
    upsertPresence("coalesced-person", { watchedSessions: undefined });
  });
  const advance = async (ms: number, calls: number) => {
    await clock.advanceBy(ms);
    expect(broadcast).toHaveBeenCalledTimes(calls);
  };
  return { clock, scheduler, broadcast, publisher, advance };
}

it("combines cross-turn changes in a fixed window while authoritative reads stay current", async () => {
  const { broadcast, publisher, advance } = setup();
  const latest = expect.objectContaining({ watchedSessions: ["agent:main:latest"] });
  upsertPresence("coalesced-person", { watchedSessions: ["agent:main:first"] });
  publisher.publish();
  await advance(199, 0);
  upsertPresence("coalesced-person", { watchedSessions: ["agent:main:latest"] });
  publisher.publish();
  expect(listSystemPresence()).toContainEqual(latest);
  await advance(1, 1);
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(
    "presence",
    { presence: expect.arrayContaining([latest]) },
    { dropIfSlow: true, stateVersion: { presence: 2, health: 1 } },
  );
  upsertPresence("coalesced-person", { reason: "disconnect", watchedSessions: undefined });
  publisher.publish();
  await advance(200, 2);
  expect(
    broadcast.mock.lastCall?.[1].presence.every(
      (row: { watchedSessions?: string[] }) => !row.watchedSessions?.includes("agent:main:latest"),
    ),
  ).toBe(true);
  broadcast.mockImplementationOnce(() => {
    throw new Error("synthetic publication failure");
  });
  publisher.publish();
  await advance(200, 3);
  publisher.publish();
  await advance(200, 4);
  broadcast.mockImplementationOnce(() => publisher.publish());
  publisher.publish();
  await advance(200, 5);
  await advance(199, 5);
  await advance(1, 6);
  expect(broadcast.mock.lastCall?.[2].stateVersion).toEqual({ presence: 7, health: 1 });
  publisher.publish();
  publisher.stop();
  publisher.publish();
  await advance(200, 6);
});

it.each([false, true])("coalesces pending preparation and joins shutdown=%s", async (stop) => {
  const preparation = createDeferred();
  let ready = false;
  const { clock, scheduler, broadcast, publisher } = setup(() =>
    ready ? undefined : preparation.promise,
  );
  try {
    publisher.publish();
    const publication = clock.advanceBy(200);
    publisher.publish();
    expect(broadcast).not.toHaveBeenCalled();
    const joined = vi.fn();
    let closing: Promise<void> | undefined;
    if (stop) {
      publisher.stop();
      closing = scheduler.stop().then(joined);
      await Promise.resolve();
      await Promise.resolve();
      expect(joined).not.toHaveBeenCalled();
    }
    ready = true;
    preparation.resolve();
    await Promise.all([publication, closing]);
    expect(joined).toHaveBeenCalledTimes(stop ? 1 : 0);
    expect(broadcast).toHaveBeenCalledTimes(stop ? 0 : 1);
    if (!stop) {
      expect(broadcast.mock.lastCall?.[2].stateVersion).toEqual({ presence: 2, health: 1 });
    }
  } finally {
    ready = true;
    preparation.resolve();
  }
});
