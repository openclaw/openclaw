/**
 * Post-compaction staging ordering.
 *
 * The ordering guarantee is:
 *
 *   Turn N (pre-compaction):
 *     1. Agent calls continue_delegate(mode="post-compaction", ...).
 *     2. Tool handler SYNCHRONOUSLY stages the delegate in the in-memory store
 *        via stagePostCompactionDelegate(). Staging completes in the same
 *        tick as the tool call — before the turn ends.
 *
 *   Compaction event (async, after turn):
 *     3. Compaction fires (context-window shrink + session rewrite).
 *     4. releasePostCompactionLifecycle() calls
 *        consumeStagedPostCompactionDelegates(sessionKey) to drain the staged
 *        bag and dispatch each entry with silentWake + drainsContinuationDelegateQueue.
 *
 * This test pins the invariant the ordering depends on: staging is
 * synchronous (post-stage count is non-zero immediately, no microtask
 * required) and consume is destructive + idempotent (a second consume
 * returns nothing). This is what makes the lifecycle ordering deterministic
 * regardless of when compaction is decided to fire.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeStagedPostCompactionDelegates,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "./continuation-delegate-store.js";

const SESSION_KEY = "channel:delegate-ordering-test";

beforeEach(() => {
  // Clean slate — drain anything a prior test left staged for this key.
  consumeStagedPostCompactionDelegates(SESSION_KEY);
});

describe("post-compaction staging ordering", () => {
  it("staging is synchronous: count is >0 immediately after stage() returns (same tick, no await)", () => {
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(0);

    // The tool handler calls stagePostCompactionDelegate() and the next
    // statement observes a non-zero count. No awaits between. This is the
    // invariant that makes the ordering deterministic — compaction can only
    // fire after the turn ends, and the turn cannot end until the tool call
    // returns. So count must be observable here.
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "rehydrate working state",
      createdAt: 1_700_000_000_000,
      silent: true,
      silentWake: true,
    });

    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(1);
  });

  it("consume drains the bag: count returns to 0 and consumed array matches what was staged", () => {
    const createdAt = 1_700_000_000_000;
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "rehydrate-A",
      createdAt,
      silent: true,
      silentWake: true,
    });
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "rehydrate-B",
      createdAt: createdAt + 1,
      silent: true,
      silentWake: true,
    });
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(2);

    const consumed = consumeStagedPostCompactionDelegates(SESSION_KEY);

    expect(consumed).toHaveLength(2);
    expect(consumed.map((d) => d.task)).toEqual(["rehydrate-A", "rehydrate-B"]);
    // The wrapper always re-asserts silent/silentWake on consume (the
    // post-compaction dispatch path requires both flags). This is part of
    // the canonical flag-set contract.
    expect(consumed[0]).toMatchObject({ silent: true, silentWake: true });
    expect(consumed[1]).toMatchObject({ silent: true, silentWake: true });
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(0);
  });

  it("re-consuming after drain returns empty: idempotent, no double-dispatch", () => {
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "rehydrate-once",
      createdAt: 1_700_000_000_000,
      silent: true,
      silentWake: true,
    });
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(1);

    const firstConsume = consumeStagedPostCompactionDelegates(SESSION_KEY);
    expect(firstConsume).toHaveLength(1);
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(0);

    // The lifecycle release path calls consume exactly once after compaction.
    // If anything ever called it a second time (e.g. a retry), this must be
    // a no-op — staged delegates must not double-dispatch.
    const secondConsume = consumeStagedPostCompactionDelegates(SESSION_KEY);
    expect(secondConsume).toEqual([]);
    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(0);

    // And a THIRD consume still returns empty.
    expect(consumeStagedPostCompactionDelegates(SESSION_KEY)).toEqual([]);
  });

  it("stage → stage → consume preserves FIFO order across multiple stages within one turn", () => {
    // A single turn might stage multiple post-compaction delegates (e.g.
    // a tool that calls continue_delegate twice). Their order at consume
    // time must match the order they were staged.
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "first",
      createdAt: 100,
      silent: true,
      silentWake: true,
    });
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "second",
      createdAt: 200,
      silent: true,
      silentWake: true,
    });
    stagePostCompactionDelegate(SESSION_KEY, {
      task: "third",
      createdAt: 300,
      silent: true,
      silentWake: true,
    });

    expect(stagedPostCompactionDelegateCount(SESSION_KEY)).toBe(3);

    const drained = consumeStagedPostCompactionDelegates(SESSION_KEY);
    expect(drained.map((d) => d.task)).toEqual(["first", "second", "third"]);
  });
});
