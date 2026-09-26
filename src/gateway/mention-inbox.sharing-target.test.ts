import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SESSION_KEY, withMentionInbox, readMentionInbox } from "./mention-inbox.test-support.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";

afterEach(() => vi.restoreAllMocks());

it("refreshes 50 connected mention views without rereading unchanged session targets", async () => {
  await withMentionInbox(
    async (f) => {
      f.clients.splice(
        0,
        f.clients.length,
        ...Array.from({ length: 50 }, (_, index) => ({
          ...f.bobClient,
          connId: `viewer-${index}`,
        })),
      );
      f.post();
      for (const client of f.clients) {
        expect(readMentionInbox(f.inbox, client).items).toHaveLength(1);
      }
      f.broadcast.mockClear();
      let exactRowReads = 0;
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the intercepted statement receiver.
      const originalGet = StatementSync.prototype.get;
      vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
        this: StatementSync,
        ...values
      ) {
        if (/from "session_nodes"/i.test(this.sourceSQL)) {
          exactRowReads++;
        }
        return originalGet.apply(this, values);
      });
      const context: Parameters<typeof emitSessionsChanged>[0] = {
        mentionInbox: f.inbox,
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: f.broadcast,
        chatAbortControllers: new Map(),
      };
      const emit = (sessionKey = "agent:main:unrelated") =>
        emitSessionsChanged(context, { sessionKey, agentId: "main", reason: "patch" });
      const start = performance.now();
      emit();
      const elapsed = performance.now() - start;
      const reads = exactRowReads;
      console.log(
        JSON.stringify({ viewers: f.clients.length, exactRowReads: reads, elapsedMs: elapsed }),
      );
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(reads).toBe(0);

      // The owner publication must invalidate even if the next fan-out names another session.
      await f.setSession({ visibility: "draft" });
      exactRowReads = 0;
      emit();
      expect(exactRowReads).toBe(1);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect(readMentionInbox(f.inbox, f.bobClient).items).toEqual([]);

      await f.setSession({ displayName: "Renamed conversation" });
      exactRowReads = 0;
      f.broadcast.mockClear();
      emit(SESSION_KEY);
      expect(exactRowReads).toBe(1);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect(readMentionInbox(f.inbox, f.bobClient).items[0]?.sessionTitle).toBe(
        "Renamed conversation",
      );

      // Target reuse never retains the viewer's identity or authorization decision.
      f.clients[0]!.authenticatedUserProfile = f.carolClient.authenticatedUserProfile;
      exactRowReads = 0;
      f.broadcast.mockClear();
      emit();
      expect(exactRowReads).toBe(0);
      expect(f.broadcast).toHaveBeenCalledTimes(1);
      expect([...f.broadcast.mock.calls[0]![2]]).toEqual(["viewer-0"]);

      // Keyless invalidation also covers in-place runtime configuration updates.
      exactRowReads = 0;
      f.inbox.invalidate();
      expect(exactRowReads).toBe(1);
    },
    {},
    { notifications: false },
  );
});
