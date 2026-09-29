import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createPresencePublisher } from "./presence-events.js";

it("combines cross-turn changes in a fixed window while authoritative reads stay current", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const broadcast = vi.fn();
  let version = 6;
  const publisher = createPresencePublisher({
    scheduler,
    broadcast,
    incrementPresenceVersion: () => ++version,
    getHealthVersion: () => 11,
    prepare: () => undefined,
  });
  try {
    upsertPresence("coalesced-person", { watchedSessions: ["agent:main:first"] });
    publisher.publish();
    await clock.advanceBy(10);
    expect(broadcast).not.toHaveBeenCalled();
    upsertPresence("coalesced-person", { watchedSessions: ["agent:main:middle"] });
    publisher.publish();
    await clock.advanceBy(189);
    expect(broadcast).not.toHaveBeenCalled();
    upsertPresence("coalesced-person", { watchedSessions: ["agent:main:latest"] });
    publisher.publish();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      listSystemPresence().some((row) => row.watchedSessions?.includes("agent:main:latest")),
    ).toBe(true);
    await clock.advanceBy(1);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({ watchedSessions: ["agent:main:latest"] }),
        ]),
      },
      { dropIfSlow: true, stateVersion: { presence: 9, health: 11 } },
    );
    upsertPresence("coalesced-person", { reason: "disconnect", watchedSessions: undefined });
    publisher.publish();
    await clock.advanceBy(200);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(
      broadcast.mock.lastCall?.[1].presence.every(
        (row: { watchedSessions?: string[] }) =>
          !row.watchedSessions?.includes("agent:main:latest"),
      ),
    ).toBe(true);
    broadcast.mockImplementationOnce(() => {
      throw new Error("synthetic publication failure");
    });
    publisher.publish();
    await clock.advanceBy(200);
    publisher.publish();
    await clock.advanceBy(200);
    expect(broadcast).toHaveBeenCalledTimes(4);
    broadcast.mockImplementationOnce(() => publisher.publish());
    publisher.publish();
    await clock.advanceBy(200);
    expect(broadcast).toHaveBeenCalledTimes(5);
    await clock.advanceBy(199);
    expect(broadcast).toHaveBeenCalledTimes(5);
    await clock.advanceBy(1);
    expect(broadcast).toHaveBeenCalledTimes(6);
    expect(broadcast.mock.lastCall?.[2].stateVersion).toEqual({ presence: 14, health: 11 });
    publisher.publish();
    publisher.stop();
    publisher.publish();
    await clock.advanceBy(200);
    expect(broadcast).toHaveBeenCalledTimes(6);
  } finally {
    publisher.stop();
    await scheduler.stop();
    upsertPresence("coalesced-person", { watchedSessions: undefined });
  }
});

it.each([false, true])(
  "coalesces while sharing facts prepare and respects stop=%s",
  async (stop) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const preparation = createDeferred();
    let ready = false;
    let version = 0;
    const broadcast = vi.fn();
    const publisher = createPresencePublisher({
      scheduler,
      broadcast,
      incrementPresenceVersion: () => ++version,
      getHealthVersion: () => 1,
      prepare: () => (ready ? undefined : preparation.promise),
    });
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
      publisher.stop();
      await scheduler.stop();
    }
  },
);
