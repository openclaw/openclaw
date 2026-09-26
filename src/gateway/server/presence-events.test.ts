import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import { createPresencePublisher } from "./presence-events.js";

afterEach(() => vi.useRealTimers());

it("publishes the latest roster once per turn while authoritative reads stay current", () => {
  vi.useFakeTimers();
  const broadcast = vi.fn();
  let version = 6;
  const publisher = createPresencePublisher({
    broadcast,
    incrementPresenceVersion: () => ++version,
    getHealthVersion: () => 11,
    prepare: () => undefined,
  });
  try {
    upsertPresence("coalesced-person", { watchedSessions: ["agent:main:first"] });
    publisher.publish();
    upsertPresence("coalesced-person", { watchedSessions: ["agent:main:latest"] });
    publisher.publish();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      listSystemPresence().some((row) => row.watchedSessions?.includes("agent:main:latest")),
    ).toBe(true);
    vi.runAllTimers();
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "presence",
      {
        presence: expect.arrayContaining([
          expect.objectContaining({ watchedSessions: ["agent:main:latest"] }),
        ]),
      },
      { dropIfSlow: true, stateVersion: { presence: 8, health: 11 } },
    );
    upsertPresence("coalesced-person", { reason: "disconnect", watchedSessions: undefined });
    publisher.publish();
    vi.runAllTimers();
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
    expect(() => vi.runAllTimers()).not.toThrow();
    publisher.publish();
    vi.runAllTimers();
    expect(broadcast).toHaveBeenCalledTimes(4);
    publisher.publish();
    publisher.stop();
    publisher.publish();
    vi.runAllTimers();
    expect(broadcast).toHaveBeenCalledTimes(4);
  } finally {
    publisher.stop();
    upsertPresence("coalesced-person", { watchedSessions: undefined });
  }
});

it.each([false, true])(
  "coalesces while sharing facts prepare and respects stop=%s",
  async (stop) => {
    vi.useFakeTimers();
    const preparation = createDeferred();
    let ready = false;
    let version = 0;
    const broadcast = vi.fn();
    const publisher = createPresencePublisher({
      broadcast,
      incrementPresenceVersion: () => ++version,
      getHealthVersion: () => 1,
      prepare: () => (ready ? undefined : preparation.promise),
    });
    try {
      publisher.publish();
      vi.runAllTimers();
      publisher.publish();
      expect(broadcast).not.toHaveBeenCalled();
      if (stop) {
        publisher.stop();
      }
      ready = true;
      preparation.resolve();
      await vi.runAllTimersAsync();
      expect(broadcast).toHaveBeenCalledTimes(stop ? 0 : 1);
      if (!stop) {
        expect(broadcast.mock.lastCall?.[2].stateVersion).toEqual({ presence: 2, health: 1 });
      }
    } finally {
      publisher.stop();
    }
  },
);
