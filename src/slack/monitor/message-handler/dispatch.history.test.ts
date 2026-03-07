import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../../auto-reply/reply/history.js";
import {
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "../../../auto-reply/reply/history.js";

/**
 * Tests the post-dispatch history strategy used by dispatchPreparedSlackMessage.
 *
 * When requireMention=true  → history is cleared after reply (existing behavior).
 * When requireMention=false → the processed message is recorded into the sliding
 * window so the next inbound message still sees recent channel context.
 */
describe("slack dispatch history strategy", () => {
  function seedHistory(): Map<string, HistoryEntry[]> {
    const map = new Map<string, HistoryEntry[]>();
    map.set("chan", [
      { sender: "Alice", body: "hello", timestamp: 1000 },
      { sender: "Bob", body: "world", timestamp: 2000 },
    ]);
    return map;
  }

  describe("requireMention=true (clear after reply)", () => {
    it("clears history after a successful reply", () => {
      const historyMap = seedHistory();
      clearHistoryEntriesIfEnabled({ historyMap, historyKey: "chan", limit: 50 });
      expect(historyMap.get("chan")).toEqual([]);
    });

    it("clears history even when no reply was delivered", () => {
      const historyMap = seedHistory();
      clearHistoryEntriesIfEnabled({ historyMap, historyKey: "chan", limit: 50 });
      expect(historyMap.get("chan")).toEqual([]);
    });
  });

  describe("requireMention=false (retain sliding window)", () => {
    it("records the processed message into history after reply", () => {
      const historyMap = seedHistory();
      recordPendingHistoryEntryIfEnabled({
        historyMap,
        historyKey: "chan",
        limit: 50,
        entry: {
          sender: "Carol",
          body: "For the current iteration",
          timestamp: 3000,
          messageId: "1772715097.681419",
        },
      });
      const entries = historyMap.get("chan")!;
      expect(entries).toHaveLength(3);
      expect(entries[2]).toMatchObject({
        sender: "Carol",
        body: "For the current iteration",
        timestamp: 3000,
      });
    });

    it("records the message even when no reply was delivered", () => {
      const historyMap = seedHistory();
      recordPendingHistoryEntryIfEnabled({
        historyMap,
        historyKey: "chan",
        limit: 50,
        entry: {
          sender: "Carol",
          body: "no reply scenario",
          timestamp: 3000,
        },
      });
      expect(historyMap.get("chan")).toHaveLength(3);
    });

    it("respects historyLimit as a sliding window cap", () => {
      const historyMap = seedHistory();
      // limit=2 means only 2 entries max
      recordPendingHistoryEntryIfEnabled({
        historyMap,
        historyKey: "chan",
        limit: 2,
        entry: { sender: "Carol", body: "third", timestamp: 3000 },
      });
      const entries = historyMap.get("chan")!;
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.sender)).toEqual(["Bob", "Carol"]);
    });

    it("preserves history across multiple replies (sliding window)", () => {
      const historyMap = new Map<string, HistoryEntry[]>();
      const limit = 5;

      // Simulate 3 messages each processed and recorded
      for (const [i, text] of ["msg1", "msg2", "msg3"].entries()) {
        recordPendingHistoryEntryIfEnabled({
          historyMap,
          historyKey: "chan",
          limit,
          entry: { sender: `User${i}`, body: text, timestamp: 1000 * (i + 1) },
        });
      }

      const entries = historyMap.get("chan")!;
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.body)).toEqual(["msg1", "msg2", "msg3"]);
    });
  });
});
