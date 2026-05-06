import { describe, it, expect, beforeEach } from "vitest";
import {
  addDelayedContinuationReservation,
  cancelPendingDelegates,
  clearDelayedContinuationReservations,
  consumeStagedPostCompactionDelegates,
  delayedContinuationReservationCount,
  enqueuePendingDelegate,
  highestDelayedContinuationReservationHop,
  listDelayedContinuationReservations,
  removeDelayedContinuationReservation,
  consumePendingDelegates,
  pendingDelegateCount,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
  takeDelayedContinuationReservation,
} from "./continuation-delegate-store.js";

describe("continuation-delegate-store", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    cancelPendingDelegates("other-session");
    clearDelayedContinuationReservations("test-session");
    clearDelayedContinuationReservations("other-session");
  });

  it("returns empty array when no delegates pending", () => {
    expect(consumePendingDelegates("test-session")).toEqual([]);
  });

  it("enqueues and consumes a single delegate", () => {
    enqueuePendingDelegate("test-session", {
      task: "summarize the RFC",
      delayMs: 0,
    });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(delegates[0].task).toBe("summarize the RFC");
    expect(delegates[0].delayMs).toBe(0);
  });

  it("consumes removes delegates from store", () => {
    enqueuePendingDelegate("test-session", { task: "task 1" });

    const first = consumePendingDelegates("test-session");
    expect(first).toHaveLength(1);

    const second = consumePendingDelegates("test-session");
    expect(second).toEqual([]);
  });

  it("supports multiple delegates per session (multi-arrow fan-out)", () => {
    enqueuePendingDelegate("test-session", { task: "arrow 1" });
    enqueuePendingDelegate("test-session", { task: "arrow 2", mode: "silent" });
    enqueuePendingDelegate("test-session", { task: "arrow 3", mode: "silent-wake" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(3);
    expect(delegates[0].task).toBe("arrow 1");
    expect(delegates[1].task).toBe("arrow 2");
    expect(delegates[1].mode).toBe("silent");
    expect(delegates[2].task).toBe("arrow 3");
    expect(delegates[2].mode).toBe("silent-wake");
  });

  it("isolates delegates by session key", () => {
    enqueuePendingDelegate("test-session", { task: "session A task" });
    enqueuePendingDelegate("other-session", { task: "session B task" });

    const a = consumePendingDelegates("test-session");
    const b = consumePendingDelegates("other-session");

    expect(a).toHaveLength(1);
    expect(a[0].task).toBe("session A task");
    expect(b).toHaveLength(1);
    expect(b[0].task).toBe("session B task");
  });

  it("pendingDelegateCount reflects current queue depth", () => {
    expect(pendingDelegateCount("test-session")).toBe(0);

    enqueuePendingDelegate("test-session", { task: "task 1" });
    expect(pendingDelegateCount("test-session")).toBe(1);

    enqueuePendingDelegate("test-session", { task: "task 2" });
    expect(pendingDelegateCount("test-session")).toBe(2);

    consumePendingDelegates("test-session");
    expect(pendingDelegateCount("test-session")).toBe(0);
  });

  it("handles delegates with no optional fields", () => {
    enqueuePendingDelegate("test-session", { task: "minimal task" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    // `flowId` + `expectedRevision` are carried through from the consumed
    // TaskFlow row so dispatch-time spawn failures can mark the row failed
    // without re-querying. The minimal-fields test only cares that no
    // optional caller-set fields leak through, so assert on `task` and
    // check the carry-through metadata shape separately.
    expect(delegates[0].task).toBe("minimal task");
    expect(typeof delegates[0].flowId).toBe("string");
    expect(delegates[0].expectedRevision).toBe(1);
    expect(delegates[0].delayMs).toBeUndefined();
    expect(delegates[0].mode).toBeUndefined();
    expect(delegates[0].targetSessionKey).toBeUndefined();
    expect(delegates[0].targetSessionKeys).toBeUndefined();
    expect(delegates[0].fanoutMode).toBeUndefined();
  });

  it("handles zero delay (immediate dispatch)", () => {
    enqueuePendingDelegate("test-session", { task: "immediate", delayMs: 0 });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates[0].delayMs).toBe(0);
  });
});

describe("delayed continuation reservations", () => {
  beforeEach(() => {
    clearDelayedContinuationReservations("test-session");
    clearDelayedContinuationReservations("other-session");
  });

  it("adds and lists reservations for a session", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-1",
      source: "tool",
      task: "inspect shard health",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 4,
      silentWake: true,
    });

    expect(listDelayedContinuationReservations("test-session")).toEqual([
      {
        id: "reservation-1",
        source: "tool",
        task: "inspect shard health",
        createdAt: 1,
        fireAt: 2,
        plannedHop: 4,
        silentWake: true,
      },
    ]);
    expect(delayedContinuationReservationCount("test-session")).toBe(1);
  });

  it("isolates reservations by session key", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-a",
      source: "bracket",
      task: "session A task",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 1,
    });
    addDelayedContinuationReservation("other-session", {
      id: "reservation-b",
      source: "tool",
      task: "session B task",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 1,
    });

    expect(delayedContinuationReservationCount("test-session")).toBe(1);
    expect(delayedContinuationReservationCount("other-session")).toBe(1);
    expect(listDelayedContinuationReservations("test-session")[0]?.task).toBe("session A task");
    expect(listDelayedContinuationReservations("other-session")[0]?.task).toBe("session B task");
  });

  it("takes one reservation by id and leaves the others intact", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-1",
      source: "tool",
      task: "first",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 1,
    });
    addDelayedContinuationReservation("test-session", {
      id: "reservation-2",
      source: "tool",
      task: "second",
      createdAt: 2,
      fireAt: 3,
      plannedHop: 2,
    });

    expect(takeDelayedContinuationReservation("test-session", "reservation-1")).toMatchObject({
      id: "reservation-1",
      task: "first",
    });
    expect(listDelayedContinuationReservations("test-session")).toEqual([
      expect.objectContaining({ id: "reservation-2", task: "second" }),
    ]);
    expect(delayedContinuationReservationCount("test-session")).toBe(1);
    expect(highestDelayedContinuationReservationHop("test-session")).toBe(2);
  });

  it("remove is idempotent for unknown reservation ids", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-1",
      source: "tool",
      task: "first",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 1,
    });

    expect(removeDelayedContinuationReservation("test-session", "missing")).toBe(false);
    expect(removeDelayedContinuationReservation("test-session", "reservation-1")).toBe(true);
    expect(removeDelayedContinuationReservation("test-session", "reservation-1")).toBe(false);
    expect(delayedContinuationReservationCount("test-session")).toBe(0);
  });

  it("clear removes all reservations for a session", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-1",
      source: "bracket",
      task: "first",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 1,
    });
    addDelayedContinuationReservation("test-session", {
      id: "reservation-2",
      source: "tool",
      task: "second",
      createdAt: 2,
      fireAt: 3,
      plannedHop: 2,
    });

    clearDelayedContinuationReservations("test-session");

    expect(listDelayedContinuationReservations("test-session")).toEqual([]);
    expect(delayedContinuationReservationCount("test-session")).toBe(0);
  });

  it("tracks the highest planned hop across outstanding reservations", () => {
    addDelayedContinuationReservation("test-session", {
      id: "reservation-1",
      source: "bracket",
      task: "first",
      createdAt: 1,
      fireAt: 2,
      plannedHop: 2,
    });
    addDelayedContinuationReservation("test-session", {
      id: "reservation-2",
      source: "tool",
      task: "second",
      createdAt: 2,
      fireAt: 3,
      plannedHop: 5,
    });

    expect(highestDelayedContinuationReservationHop("test-session")).toBe(5);

    removeDelayedContinuationReservation("test-session", "reservation-2");
    expect(highestDelayedContinuationReservationHop("test-session")).toBe(2);

    clearDelayedContinuationReservations("test-session");
    expect(highestDelayedContinuationReservationHop("test-session")).toBe(0);
  });
});

describe("post-compaction delegate staging", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    cancelPendingDelegates("other-session");
  });

  it("returns empty array when no staged delegates are pending", () => {
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([]);
  });

  it("stages and consumes a post-compaction delegate", () => {
    stagePostCompactionDelegate("test-session", {
      task: "carry working state past compaction",
      createdAt: 123,
    });

    const delegates = consumeStagedPostCompactionDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(delegates[0].task).toBe("carry working state past compaction");
    expect(typeof delegates[0].createdAt).toBe("number");
  });

  it("consuming removes staged delegates from store", () => {
    stagePostCompactionDelegate("test-session", { task: "task 1", createdAt: 1 });

    const first = consumeStagedPostCompactionDelegates("test-session");
    expect(first).toHaveLength(1);

    const second = consumeStagedPostCompactionDelegates("test-session");
    expect(second).toEqual([]);
  });

  it("supports multiple staged delegates per session", () => {
    stagePostCompactionDelegate("test-session", { task: "shard 1", createdAt: 1 });
    stagePostCompactionDelegate("test-session", { task: "shard 2", createdAt: 2 });
    stagePostCompactionDelegate("test-session", { task: "shard 3", createdAt: 3 });

    const delegates = consumeStagedPostCompactionDelegates("test-session");
    expect(delegates).toHaveLength(3);
    expect(delegates.map((d) => d.task)).toEqual(["shard 1", "shard 2", "shard 3"]);
  });

  it("isolates staged delegates by session key", () => {
    stagePostCompactionDelegate("test-session", { task: "session A", createdAt: 1 });
    stagePostCompactionDelegate("other-session", { task: "session B", createdAt: 1 });

    expect(consumeStagedPostCompactionDelegates("test-session")).toHaveLength(1);
    expect(consumeStagedPostCompactionDelegates("other-session")).toHaveLength(1);
  });

  it("staged delegates are separate from immediate delegates", () => {
    enqueuePendingDelegate("test-session", { task: "immediate task" });
    stagePostCompactionDelegate("test-session", { task: "compaction task", createdAt: 1 });

    expect(pendingDelegateCount("test-session")).toBe(1);
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(1);

    const immediate = consumePendingDelegates("test-session");
    expect(immediate).toHaveLength(1);
    expect(immediate[0].task).toBe("immediate task");

    const compaction = consumeStagedPostCompactionDelegates("test-session");
    expect(compaction).toHaveLength(1);
    expect(compaction[0].task).toBe("compaction task");
  });

  it("stagedPostCompactionDelegateCount reflects current queue depth", () => {
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(0);

    stagePostCompactionDelegate("test-session", { task: "task 1", createdAt: 1 });
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(1);

    stagePostCompactionDelegate("test-session", { task: "task 2", createdAt: 2 });
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(2);

    consumeStagedPostCompactionDelegates("test-session");
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(0);
  });
});
