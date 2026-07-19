// Tests for node wake state tracking and testing seam.
import { beforeEach, describe, expect, it } from "vitest";
import {
  NODE_WAKE_RECONNECT_WAIT_MS,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_POLL_MS,
  captureNodeWakeLifecycle,
  clearNodeWakeState,
  invalidateNodeWakeState,
  isNodeWakeLifecycleCurrent,
  nodeWakeByOwner,
  nodeWakeNudgeByOwner,
  nodeWakeStateKey,
  releaseNodeWakeLifecycle,
} from "./nodes-wake-state.js";

beforeEach(() => {
  nodeWakeByOwner.clear();
  nodeWakeNudgeByOwner.clear();
});

describe("constants", () => {
  it("exports expected wait/poll constants", () => {
    expect(NODE_WAKE_RECONNECT_WAIT_MS).toBe(3_000);
    expect(NODE_WAKE_RECONNECT_RETRY_WAIT_MS).toBe(12_000);
    expect(NODE_WAKE_RECONNECT_POLL_MS).toBe(150);
  });
});

describe("nodeWakeByOwner", () => {
  it("starts empty", () => {
    expect(nodeWakeByOwner.size).toBe(0);
  });

  it("stores NodeWakeState entries", () => {
    const now = Date.now();
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), { lastWakeAtMs: now });
    expect(nodeWakeByOwner.size).toBe(1);
    expect(nodeWakeByOwner.get(nodeWakeStateKey("node-1"))?.lastWakeAtMs).toBe(now);
  });

  it("stores multiple entries", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("a"), { lastWakeAtMs: 100 });
    nodeWakeByOwner.set(nodeWakeStateKey("b"), { lastWakeAtMs: 200 });
    nodeWakeByOwner.set(nodeWakeStateKey("c"), { lastWakeAtMs: 300 });
    expect(nodeWakeByOwner.size).toBe(3);
  });

  it("overwrites existing entry when key is reused", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), { lastWakeAtMs: 100 });
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), { lastWakeAtMs: 200 });
    expect(nodeWakeByOwner.size).toBe(1);
  });

  it("stores independent entries for replacement pairing generations", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("node-1", "generation-1"), { lastWakeAtMs: 100 });
    nodeWakeByOwner.set(nodeWakeStateKey("node-1", "generation-2"), { lastWakeAtMs: 200 });

    expect(nodeWakeByOwner.get(nodeWakeStateKey("node-1", "generation-1"))?.lastWakeAtMs).toBe(100);
    expect(nodeWakeByOwner.get(nodeWakeStateKey("node-1", "generation-2"))?.lastWakeAtMs).toBe(200);
  });

  it("supports inFlight promise property", () => {
    const promise = Promise.resolve({
      available: true,
      throttled: false,
      path: "sent" as const,
      durationMs: 50,
    });
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), {
      lastWakeAtMs: Date.now(),
      inFlight: promise,
    });
    expect(nodeWakeByOwner.get(nodeWakeStateKey("node-1"))?.inFlight).toBe(promise);
  });
});

describe("nodeWakeNudgeByOwner", () => {
  it("starts empty", () => {
    expect(nodeWakeNudgeByOwner.size).toBe(0);
  });

  it("stores nudge timestamps", () => {
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1"), 1000);
    expect(nodeWakeNudgeByOwner.size).toBe(1);
    expect(nodeWakeNudgeByOwner.get(nodeWakeStateKey("node-1"))).toBe(1000);
  });

  it("independently tracked from nodeWakeByOwner", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), { lastWakeAtMs: 500 });
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1"), 1000);
    expect(nodeWakeByOwner.size).toBe(1);
    expect(nodeWakeNudgeByOwner.size).toBe(1);
  });
});

describe("clearNodeWakeState", () => {
  it("removes the wake entry and nudge for the given node", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("node-1"), { lastWakeAtMs: 100 });
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1"), 200);
    clearNodeWakeState("node-1");
    expect(nodeWakeByOwner.has(nodeWakeStateKey("node-1"))).toBe(false);
    expect(nodeWakeNudgeByOwner.has(nodeWakeStateKey("node-1"))).toBe(false);
  });

  it("preserves an active lifecycle while clearing disconnect throttle state", () => {
    const activeLifecycle = captureNodeWakeLifecycle("node-1");
    nodeWakeByOwner.get(nodeWakeStateKey("node-1"))!.lastWakeAtMs = 100;
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1"), 200);

    clearNodeWakeState("node-1");

    expect(nodeWakeByOwner.has(nodeWakeStateKey("node-1"))).toBe(false);
    expect(nodeWakeNudgeByOwner.has(nodeWakeStateKey("node-1"))).toBe(false);
    expect(activeLifecycle.aborted).toBe(false);
    expect(isNodeWakeLifecycleCurrent("node-1", activeLifecycle)).toBe(true);

    releaseNodeWakeLifecycle("node-1", activeLifecycle);
    expect(isNodeWakeLifecycleCurrent("node-1", activeLifecycle)).toBe(false);
  });

  it("invalidates a removed node lifecycle before the node id can be reused", () => {
    const removedLifecycle = captureNodeWakeLifecycle("node-1");

    invalidateNodeWakeState("node-1");

    expect(removedLifecycle.aborted).toBe(true);
    expect(isNodeWakeLifecycleCurrent("node-1", removedLifecycle)).toBe(false);
    const replacementLifecycle = captureNodeWakeLifecycle("node-1");
    expect(replacementLifecycle).not.toBe(removedLifecycle);
    expect(isNodeWakeLifecycleCurrent("node-1", replacementLifecycle)).toBe(true);
    releaseNodeWakeLifecycle("node-1", replacementLifecycle);
  });

  it("does not treat one pairing generation lifecycle as current for another", () => {
    const generationOne = captureNodeWakeLifecycle("node-1", "generation-1");
    const generationTwo = captureNodeWakeLifecycle("node-1", "generation-2");

    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-1")).toBe(true);
    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-2")).toBe(false);
    expect(isNodeWakeLifecycleCurrent("node-1", generationTwo, "generation-2")).toBe(true);

    invalidateNodeWakeState("node-1");
  });

  it("is a no-op when the node id does not exist", () => {
    expect(() => clearNodeWakeState("ghost")).not.toThrow();
    expect(nodeWakeByOwner.size).toBe(0);
    expect(nodeWakeNudgeByOwner.size).toBe(0);
  });

  it("only removes the specified node, leaving others intact", () => {
    nodeWakeByOwner.set(nodeWakeStateKey("a"), { lastWakeAtMs: 1 });
    nodeWakeByOwner.set(nodeWakeStateKey("b"), { lastWakeAtMs: 2 });
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("a"), 10);
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("b"), 20);
    clearNodeWakeState("a");
    expect(nodeWakeByOwner.has(nodeWakeStateKey("a"))).toBe(false);
    expect(nodeWakeByOwner.has(nodeWakeStateKey("b"))).toBe(true);
    expect(nodeWakeNudgeByOwner.has(nodeWakeStateKey("a"))).toBe(false);
    expect(nodeWakeNudgeByOwner.has(nodeWakeStateKey("b"))).toBe(true);
  });

  it("removes every generation owned by the specified node", () => {
    const generationOne = captureNodeWakeLifecycle("node-1", "generation-1");
    const generationTwo = captureNodeWakeLifecycle("node-1", "generation-2");
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1", "generation-1"), 10);
    nodeWakeNudgeByOwner.set(nodeWakeStateKey("node-1", "generation-2"), 20);

    invalidateNodeWakeState("node-1");

    expect(generationOne.aborted).toBe(true);
    expect(generationTwo.aborted).toBe(true);
    expect(nodeWakeByOwner.size).toBe(0);
    expect(nodeWakeNudgeByOwner.size).toBe(0);
  });
});
