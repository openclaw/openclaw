import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { emitSessionsChanged, flushPendingSessionsChangedEvents } from "./session-change-event.js";

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
});

it.each([false, true])(
  "coalesces keyless refreshes without repeating prepared facts (prepared=%s)",
  async (preparedPublication) => {
    const context = {
      getRuntimeConfig: () => ({}),
      chatAbortControllers: new Map(),
      getSessionEventSubscriberConnIds: () => new Set(["listener"]),
      broadcastToConnIds: vi.fn(),
    } satisfies Parameters<typeof emitSessionsChanged>[0];
    const facts = vi.fn();
    const unsubscribe = sessionChanges.subscribeFacts(facts);
    const accessRevision = readGatewayAccessRevision();
    try {
      for (let index = 0; index < 3; index += 1) {
        emitSessionsChanged(context, { reason: "delete" }, { preparedPublication });
      }
      expect(context.broadcastToConnIds.mock.calls.length).toBeLessThan(3);
      expect(facts).toHaveBeenCalledTimes(preparedPublication ? 0 : 3);
      expect(readGatewayAccessRevision()).toBe(accessRevision + 3);

      await flushPendingSessionsChangedEvents(context);
      expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
      expect(context.broadcastToConnIds).toHaveBeenLastCalledWith(
        "sessions.changed",
        expect.objectContaining({ reason: "delete" }),
        new Set(["listener"]),
        expect.any(Object),
      );
    } finally {
      unsubscribe();
    }
  },
);
