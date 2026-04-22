import { afterEach, describe, expect, it } from "vitest";
import {
  __testing as registryTesting,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import {
  __testing,
  forgetGeneration,
  getCurrentGeneration,
  incrementGeneration,
  isCurrentGeneration,
} from "./run-generation.js";

afterEach(() => {
  __testing.resetRunGenerationRegistry();
  registryTesting.resetReplyRunRegistry();
});

describe("run-generation registry", () => {
  it("starts at generation 0 for an unseen session", () => {
    expect(getCurrentGeneration("session-a")).toBe(0);
    expect(isCurrentGeneration("session-a", 0)).toBe(true);
  });

  it("increments monotonically per session", () => {
    expect(incrementGeneration("session-a")).toBe(1);
    expect(incrementGeneration("session-a")).toBe(2);
    expect(incrementGeneration("session-a")).toBe(3);
    expect(getCurrentGeneration("session-a")).toBe(3);
  });

  it("isolates generations across sessions", () => {
    incrementGeneration("session-a");
    incrementGeneration("session-a");
    incrementGeneration("session-b");

    expect(getCurrentGeneration("session-a")).toBe(2);
    expect(getCurrentGeneration("session-b")).toBe(1);
  });

  it("invalidates stale generations when the current one moves forward", () => {
    const captured = incrementGeneration("session-a");
    expect(isCurrentGeneration("session-a", captured)).toBe(true);
    incrementGeneration("session-a");
    expect(isCurrentGeneration("session-a", captured)).toBe(false);
  });

  it("treats the baseline 0 as current until first increment", () => {
    expect(getCurrentGeneration("session-new")).toBe(0);
    expect(isCurrentGeneration("session-new", 0)).toBe(true);
    incrementGeneration("session-new");
    expect(isCurrentGeneration("session-new", 0)).toBe(false);
  });

  it("treats missing sessionKey as invalid", () => {
    expect(getCurrentGeneration("")).toBe(0);
    expect(incrementGeneration("")).toBe(0);
    expect(isCurrentGeneration("", 0)).toBe(false);
  });

  it("rejects non-finite generations", () => {
    incrementGeneration("session-a");
    expect(isCurrentGeneration("session-a", Number.NaN)).toBe(false);
    expect(isCurrentGeneration("session-a", Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("forgets a session without affecting others", () => {
    incrementGeneration("session-a");
    incrementGeneration("session-b");
    forgetGeneration("session-a");

    expect(getCurrentGeneration("session-a")).toBe(0);
    expect(getCurrentGeneration("session-b")).toBe(1);
    expect(__testing.peekTrackedSessionCount()).toBe(1);
  });

  it("matches the CLAUDE_CODE_PROMPT.md Test 1 scenario (invalidation)", () => {
    // Start a run for sessionKey "test-session"
    const g1 = incrementGeneration("test-session");
    // Capture generation G1
    expect(isCurrentGeneration("test-session", g1)).toBe(true);
    // Increment generation (simulates abort or new-message takeover)
    const g2 = incrementGeneration("test-session");
    // Old generation is no longer current; new one is
    expect(isCurrentGeneration("test-session", g1)).toBe(false);
    expect(isCurrentGeneration("test-session", g2)).toBe(true);
    expect(g2).toBe(g1 + 1);
  });
});

describe("reply-run-registry generation wiring", () => {
  it("captures the session's current generation at run begin", () => {
    const operation = createReplyOperation({
      sessionKey: "sess-1",
      sessionId: "sid-1",
      resetTriggered: false,
    });

    expect(operation.runGeneration).toBe(0);
    expect(operation.isCurrent()).toBe(true);
  });

  it("flips isCurrent() to false after abortByUser", () => {
    const operation = createReplyOperation({
      sessionKey: "sess-2",
      sessionId: "sid-2",
      resetTriggered: false,
    });
    const captured = operation.runGeneration;

    operation.abortByUser();

    expect(operation.isCurrent()).toBe(false);
    expect(isCurrentGeneration("sess-2", captured)).toBe(false);
    expect(getCurrentGeneration("sess-2")).toBe(captured + 1);
  });

  it("bumps the generation when replyRunRegistry.abort succeeds", () => {
    createReplyOperation({
      sessionKey: "sess-3",
      sessionId: "sid-3",
      resetTriggered: false,
    });
    const baseline = getCurrentGeneration("sess-3");

    const aborted = replyRunRegistry.abort("sess-3");

    expect(aborted).toBe(true);
    expect(getCurrentGeneration("sess-3")).toBe(baseline + 1);
  });

  it("lets a follow-up run capture the new generation", () => {
    const first = createReplyOperation({
      sessionKey: "sess-4",
      sessionId: "sid-4",
      resetTriggered: false,
    });
    first.abortByUser();

    const second = createReplyOperation({
      sessionKey: "sess-4",
      sessionId: "sid-4b",
      resetTriggered: false,
    });

    expect(second.runGeneration).toBeGreaterThan(first.runGeneration);
    expect(second.isCurrent()).toBe(true);
    expect(first.isCurrent()).toBe(false);
  });
});

describe("stale-output fence (Piece C pattern)", () => {
  // CLAUDE_CODE_PROMPT.md Test 3: stale output suppression.
  // Demonstrates that emission points wired to operation.isCurrent() drop
  // deltas from a superseded run. Real emission points (block-reply-pipeline,
  // typing, reply-delivery, followup-delivery) should reproduce this shape.
  it("drops a delta emitted after the generation was bumped", () => {
    const delivered: string[] = [];
    const operation = createReplyOperation({
      sessionKey: "sess-fence",
      sessionId: "sid-fence",
      resetTriggered: false,
    });

    const tryEmit = (text: string) => {
      if (!operation.isCurrent()) {
        return;
      }
      delivered.push(text);
    };

    tryEmit("delta 1");
    // A new user message arrives and bumps the generation.
    incrementGeneration("sess-fence");
    tryEmit("delta 2");

    expect(delivered).toEqual(["delta 1"]);
    expect(operation.isCurrent()).toBe(false);
  });

  // CLAUDE_CODE_PROMPT.md Test 5: typing/progress cease on abort.
  // The registry bumps the generation as part of abortByUser, so any typing
  // controller that consults isCurrent() before refreshing sees stop=true.
  it("stops emitting progress after abort", () => {
    const progress: number[] = [];
    const operation = createReplyOperation({
      sessionKey: "sess-typing",
      sessionId: "sid-typing",
      resetTriggered: false,
    });

    const tick = (step: number) => {
      if (!operation.isCurrent()) {
        return;
      }
      progress.push(step);
    };

    tick(1);
    tick(2);
    operation.abortByUser();
    tick(3);
    tick(4);

    expect(progress).toEqual([1, 2]);
  });

  // CLAUDE_CODE_PROMPT.md Test 2: pre-tool gate skips subsequent tools.
  // Simulates a tool batch where `/stop` arrives mid-batch.
  it("skips pending tools in a batch once the run is invalidated", () => {
    const executed: string[] = [];
    const operation = createReplyOperation({
      sessionKey: "sess-tools",
      sessionId: "sid-tools",
      resetTriggered: false,
    });

    const dispatch = (toolName: string) => {
      if (!operation.isCurrent()) {
        return { content: "[cancelled — run interrupted]", isError: false };
      }
      executed.push(toolName);
      return { content: `ran ${toolName}`, isError: false };
    };

    const resA = dispatch("tool_a");
    // External abort (e.g., user sends /stop) arrives between tool A and B.
    replyRunRegistry.abort("sess-tools");
    const resB = dispatch("tool_b");
    const resC = dispatch("tool_c");

    expect(executed).toEqual(["tool_a"]);
    expect(resA.content).toBe("ran tool_a");
    expect(resB.content).toBe("[cancelled — run interrupted]");
    expect(resC.content).toBe("[cancelled — run interrupted]");
  });
});
