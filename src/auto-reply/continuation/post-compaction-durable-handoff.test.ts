import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingDelegates,
  consumeStagedPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  recoverStagedPostCompactionDelegates,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "../continuation-delegate-store.js";

// #1144 (r3507184780): staged post-compaction delegates must stay non-terminal
// until the durable handoff (session-delivery enqueue / session-store persist)
// succeeds. consumeStagedPostCompactionDelegates now claims the TaskFlow row to
// `running`; finalizeStagedPostCompactionDelegates finishes it only after the
// handoff, and recoverStagedPostCompactionDelegates resets crash-orphaned
// `running` rows to `queued`.

const sessionKey = "post-compaction-durable-handoff-test";

describe("post-compaction durable handoff (#1144)", () => {
  beforeEach(() => {
    cancelPendingDelegates(sessionKey);
  });
  afterEach(() => {
    cancelPendingDelegates(sessionKey);
    vi.useRealTimers();
  });

  function stage(task: string): void {
    stagePostCompactionDelegate(sessionKey, {
      task,
      createdAt: 1_700_000_000_000,
      silent: true,
      silentWake: true,
    });
  }

  it("consume claims the row without terminalizing it (recoverable on crash before handoff)", () => {
    stage("evacuate context");
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(1);

    // Release (claim -> running). The row leaves the queued lane but is NOT
    // finished — the caller has not yet handed it off durably.
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ task: "evacuate context" });
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);

    // Simulate a crash between release and durable handoff: finalize never runs.
    // Restart recovery must resurrect the claimed row instead of losing it.
    const recovered = recoverStagedPostCompactionDelegates();
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(1);

    // The recovered row is queued again and re-consumable at the next seam.
    const rereleased = consumeStagedPostCompactionDelegates(sessionKey);
    expect(rereleased).toHaveLength(1);
    expect(rereleased[0]).toMatchObject({ task: "evacuate context" });
  });

  it("finalize after handoff terminalizes the row so recovery cannot replay it", () => {
    stage("evacuate context");
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);

    // Durable handoff succeeded: finalize exactly the claimed row.
    const finalized = finalizeStagedPostCompactionDelegates(released.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // No running rows remain, so recovery is a no-op and nothing re-queues.
    expect(recoverStagedPostCompactionDelegates()).toBe(0);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);
    expect(consumeStagedPostCompactionDelegates(sessionKey)).toHaveLength(0);
  });

  it("finalizes only the rows this caller claimed, leaving others recoverable", () => {
    stage("first");
    const firstRelease = consumeStagedPostCompactionDelegates(sessionKey);
    expect(firstRelease).toHaveLength(1);

    // A second delegate is staged and claimed by an independent/other consume;
    // its row must survive the first caller's finalize (a crash-orphaned or
    // concurrently-claimed row must never be terminalized out from under it).
    stage("second");
    const secondRelease = consumeStagedPostCompactionDelegates(sessionKey);
    expect(secondRelease).toHaveLength(1);

    // Finalizing only the first caller's flow ids finishes only the first row.
    const finalized = finalizeStagedPostCompactionDelegates(firstRelease.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // The second (independently-claimed) row is untouched and still recoverable.
    expect(recoverStagedPostCompactionDelegates()).toBeGreaterThanOrEqual(1);
    const rereleased = consumeStagedPostCompactionDelegates(sessionKey);
    expect(rereleased.map((d) => d.task)).toContain("second");
  });

  it("re-staging before finalize preserves a delegate when the durable persist fails", () => {
    // Models the persist-failure path (agent-runner / dispatch): after claiming
    // the row to `running`, a fresh queued row is re-staged BEFORE the claimed
    // row is finalized, so a crash cannot drop the delegate behind a premature
    // `finished` row (#1144 autoreview follow-up).
    stage("evacuate context");
    const released = consumeStagedPostCompactionDelegates(sessionKey);
    expect(released).toHaveLength(1);
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(0);

    // Re-stage a fresh queued row (durable) BEFORE finalizing the claimed row.
    stagePostCompactionDelegate(sessionKey, released[0]);
    const finalized = finalizeStagedPostCompactionDelegates(released.map((d) => d.flowId));
    expect(finalized).toBe(1);

    // The re-staged queued row survives; the old claimed row is terminal, so
    // recovery finds nothing to reset and the delegate is not duplicated.
    expect(stagedPostCompactionDelegateCount(sessionKey)).toBe(1);
    expect(recoverStagedPostCompactionDelegates()).toBe(0);
    const rereleased = consumeStagedPostCompactionDelegates(sessionKey);
    expect(rereleased.map((d) => d.task)).toContain("evacuate context");
  });
});
