import { beforeEach, describe, expect, it } from "vitest";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  hashSessionKey,
  listReceiptsForSession,
  pruneReceiptsForSession,
  recordReceipt,
  resetDeliveryReceiptsForTest,
  summarizeDeliveryReceipts,
} from "./delivery-receipts.js";

describe("delivery-receipts", () => {
  beforeEach(() => {
    resetDeliveryReceiptsForTest();
  });

  it("records and returns receipts for a session in chronological order", () => {
    for (let i = 0; i < 5; i += 1) {
      recordReceipt("sess-A", {
        target: { channel: "discord", to: "channel:1" },
        messageClass: "final_reply",
        outcome: "delivered",
        reason: `r-${i}`,
        ts: 1000 + i,
        resolvedContextAt: 1000 + i,
      });
    }
    const receipts = listReceiptsForSession("sess-A");
    expect(receipts).toHaveLength(5);
    expect(receipts.map((r) => r.reason)).toEqual(["r-0", "r-1", "r-2", "r-3", "r-4"]);
    expect(receipts[0]?.sessionKeyHash).toBeDefined();
    expect(receipts[0]?.sessionKeyHash).not.toBe("sess-A"); // hashed
  });

  it("caps per-session storage at 50 and evicts oldest (index-based ring)", () => {
    for (let i = 0; i < 75; i += 1) {
      recordReceipt("sess-B", {
        target: { channel: "discord", to: "channel:1" },
        messageClass: "progress",
        outcome: "delivered",
        reason: `r-${i}`,
        ts: i,
        resolvedContextAt: i,
      });
    }
    const receipts = listReceiptsForSession("sess-B");
    expect(receipts).toHaveLength(50);
    // Should contain the most-recent 50 entries (r-25 .. r-74) in order.
    expect(receipts[0]?.reason).toBe("r-25");
    expect(receipts[49]?.reason).toBe("r-74");
  });

  it("honors the limit parameter and returns the most-recent entries", () => {
    for (let i = 0; i < 10; i += 1) {
      recordReceipt("sess-C", {
        target: { channel: "discord", to: "channel:1" },
        messageClass: "progress",
        outcome: "delivered",
        reason: `r-${i}`,
        ts: i,
        resolvedContextAt: i,
      });
    }
    const receipts = listReceiptsForSession("sess-C", 3);
    expect(receipts.map((r) => r.reason)).toEqual(["r-7", "r-8", "r-9"]);
  });

  it("hashes session keys (HMAC) so cross-session enumeration is not possible", () => {
    const hash1 = hashSessionKey("sess-X");
    const hash2 = hashSessionKey("sess-X");
    const hash3 = hashSessionKey("sess-Y");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).not.toBe("sess-X");
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scopes receipts to the right session", () => {
    recordReceipt("sess-scope-A", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 1,
      resolvedContextAt: 1,
    });
    recordReceipt("sess-scope-B", {
      target: { channel: "discord", to: "channel:2" },
      messageClass: "final_reply",
      outcome: "suppressed",
      reason: "no_origin",
      ts: 2,
      resolvedContextAt: 2,
    });
    expect(listReceiptsForSession("sess-scope-A")).toHaveLength(1);
    expect(listReceiptsForSession("sess-scope-B")).toHaveLength(1);
    expect(listReceiptsForSession("sess-scope-B")[0]?.outcome).toBe("suppressed");
  });

  it("prunes receipts when a session lifecycle 'ended' event fires", () => {
    recordReceipt("sess-life", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 1,
      resolvedContextAt: 1,
    });
    expect(listReceiptsForSession("sess-life")).toHaveLength(1);
    emitSessionLifecycleEvent({ sessionKey: "sess-life", reason: "ended" });
    expect(listReceiptsForSession("sess-life")).toHaveLength(0);
  });

  it("keeps receipts on non-ended lifecycle events", () => {
    recordReceipt("sess-keep", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 1,
      resolvedContextAt: 1,
    });
    emitSessionLifecycleEvent({ sessionKey: "sess-keep", reason: "closed-sibling" });
    expect(listReceiptsForSession("sess-keep")).toHaveLength(1);
  });

  it("summarizes delivered and suppressed counts across sessions", () => {
    recordReceipt("sess-sum-A", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 100,
      resolvedContextAt: 100,
    });
    recordReceipt("sess-sum-A", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "progress",
      outcome: "suppressed",
      reason: "class_suppressed_for_surface",
      ts: 101,
      resolvedContextAt: 101,
    });
    recordReceipt("sess-sum-B", {
      target: { channel: "discord", to: "channel:2" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 102,
      resolvedContextAt: 102,
    });
    const summary = summarizeDeliveryReceipts();
    expect(summary.totalRecorded).toBe(3);
    expect(summary.totalDelivered).toBe(2);
    expect(summary.totalSuppressed).toBe(1);
    expect(summary.sessionsTracked).toBe(2);
    expect(summary.lastRecordedAt).toBeGreaterThanOrEqual(102);
  });

  it("pruneReceiptsForSession drops the bucket", () => {
    recordReceipt("sess-prune", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      ts: 1,
      resolvedContextAt: 1,
    });
    pruneReceiptsForSession("sess-prune");
    expect(listReceiptsForSession("sess-prune")).toHaveLength(0);
  });

  it("ignores empty session keys gracefully", () => {
    expect(
      recordReceipt("", {
        target: { channel: "discord", to: "channel:1" },
        messageClass: "final_reply",
        outcome: "delivered",
        ts: 1,
        resolvedContextAt: 1,
      }),
    ).toBe(false);
    expect(listReceiptsForSession("")).toHaveLength(0);
  });
});
