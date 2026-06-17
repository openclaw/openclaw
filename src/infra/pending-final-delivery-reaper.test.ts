// Coverage for the pending-final-delivery reaper (#93625) and its two
// maintainer-requested invariants: flush only when definitively terminal, and
// idempotent across gateway restarts.
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  type PendingFinalDeliveryReaperDeps,
  type StrandedReply,
  reapStrandedPendingFinalDeliveries,
} from "./pending-final-delivery-reaper.js";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-1",
    status: "done",
    pendingFinalDelivery: true,
    pendingFinalDeliveryText: "hi from the agent",
    pendingFinalDeliveryCreatedAt: 0,
    pendingFinalDeliveryIntentId: "intent-1",
    ...overrides,
  } as SessionEntry;
}

function makeDeps(
  entries: StrandedReply[],
  overrides: Partial<PendingFinalDeliveryReaperDeps> = {},
): PendingFinalDeliveryReaperDeps {
  return {
    listEntries: () => entries,
    isRunActive: () => false,
    deliver: vi.fn(async () => true),
    clearPending: vi.fn(async () => {}),
    recordFailedAttempt: vi.fn(async () => {}),
    now: () => 10_000_000, // well past the default grace window
    ...overrides,
  };
}

describe("reapStrandedPendingFinalDeliveries", () => {
  it("invariant 1: does not flush while the owning run is still live", async () => {
    const deps = makeDeps([{ sessionKey: "k", entry: entry() }], {
      isRunActive: () => true, // real run handle still present
    });
    const result = await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.clearPending).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reaped: 0, skipped: 1 });
  });

  it("invariant 1: does not flush when the run status is not terminal", async () => {
    const deps = makeDeps([{ sessionKey: "k", entry: entry({ status: "running" }) }]);
    await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("flushes a definitively-terminal stranded reply and clears it", async () => {
    const reply = { sessionKey: "k", entry: entry() };
    const deps = makeDeps([reply]);
    const result = await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.deliver).toHaveBeenCalledWith(reply);
    expect(deps.clearPending).toHaveBeenCalledWith(reply);
    expect(result).toMatchObject({ scanned: 1, reaped: 1 });
  });

  it("respects the grace window so normal replay paths win first", async () => {
    const deps = makeDeps(
      [{ sessionKey: "k", entry: entry({ pendingFinalDeliveryCreatedAt: 9_999_999 }) }],
      {
        now: () => 10_000_000, // only ~1ms old
      },
    );
    await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("stops retrying after the attempt cap", async () => {
    const deps = makeDeps([
      { sessionKey: "k", entry: entry({ pendingFinalDeliveryAttemptCount: 3 }) },
    ]);
    await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("invariant 2: a delivered+cleared reply is not re-delivered on a later pass", async () => {
    // clearPending mutates the entry the way the real atomic store update does.
    const reply = { sessionKey: "k", entry: entry() };
    const deps = makeDeps([reply], {
      clearPending: vi.fn(async (r: StrandedReply) => {
        r.entry.pendingFinalDelivery = false;
        r.entry.pendingFinalDeliveryText = null;
      }),
    });
    await reapStrandedPendingFinalDeliveries(deps); // delivers + clears
    await reapStrandedPendingFinalDeliveries(deps); // second pass: nothing to do
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("invariant 2: failed delivery records an attempt and does NOT clear", async () => {
    const reply = { sessionKey: "k", entry: entry() };
    const deps = makeDeps([reply], {
      deliver: vi.fn(async () => {
        throw new Error("channel offline");
      }),
    });
    const result = await reapStrandedPendingFinalDeliveries(deps);
    expect(deps.recordFailedAttempt).toHaveBeenCalledWith(reply, "channel offline");
    expect(deps.clearPending).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1 });
  });
});
