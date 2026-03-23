import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPolicyFeedbackEngine,
  getPolicyFeedbackMode,
  getPolicyHintsSafe,
  isPolicyFeedbackActive,
  logPolicyAction,
  setPolicyFeedbackEngine,
} from "./gateway-bridge.js";
import type { PolicyFeedbackEngine } from "./types.js";

function createMockEngine(overrides?: Partial<PolicyFeedbackEngine>): PolicyFeedbackEngine {
  return {
    logAction: vi.fn().mockResolvedValue({ actionId: "test-001" }),
    logOutcome: vi.fn().mockResolvedValue(undefined),
    rankCandidates: vi.fn().mockResolvedValue([]),
    getPolicyHints: vi.fn().mockResolvedValue({
      recommendation: "proceed",
      reasons: [],
      fatigueLevel: 0,
      activeConstraints: [],
      mode: "advisory",
    }),
    recomputeAggregates: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ mode: "advisory" }),
    explainScore: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  clearPolicyFeedbackEngine();
});

describe("setPolicyFeedbackEngine / clearPolicyFeedbackEngine", () => {
  it("activates the bridge when engine is set", () => {
    expect(isPolicyFeedbackActive()).toBe(false);
    setPolicyFeedbackEngine(createMockEngine(), "advisory");
    expect(isPolicyFeedbackActive()).toBe(true);
    expect(getPolicyFeedbackMode()).toBe("advisory");
  });

  it("deactivates on clear", () => {
    setPolicyFeedbackEngine(createMockEngine(), "advisory");
    clearPolicyFeedbackEngine();
    expect(isPolicyFeedbackActive()).toBe(false);
    expect(getPolicyFeedbackMode()).toBe("off");
  });
});

describe("getPolicyHintsSafe", () => {
  it("returns defaults when no engine is set", async () => {
    const hints = await getPolicyHintsSafe({
      agentId: "a",
      sessionKey: "s",
      channelId: "c",
    });
    expect(hints.recommendation).toBe("proceed");
    expect(hints.mode).toBe("off");
  });

  it("delegates to engine when set", async () => {
    const engine = createMockEngine();
    setPolicyFeedbackEngine(engine, "advisory");
    const hints = await getPolicyHintsSafe({
      agentId: "a",
      sessionKey: "s",
      channelId: "c",
    });
    expect(engine.getPolicyHints).toHaveBeenCalledOnce();
    expect(hints.recommendation).toBe("proceed");
  });

  it("returns defaults on engine error", async () => {
    const engine = createMockEngine({
      getPolicyHints: vi.fn().mockRejectedValue(new Error("boom")),
    });
    setPolicyFeedbackEngine(engine, "advisory");
    const hints = await getPolicyHintsSafe({
      agentId: "a",
      sessionKey: "s",
      channelId: "c",
    });
    expect(hints.recommendation).toBe("proceed");
  });
});

describe("logPolicyAction", () => {
  it("is a no-op when no engine is set", () => {
    // Should not throw
    logPolicyAction({
      agentId: "a",
      sessionKey: "s",
      actionType: "heartbeat_run",
      channelId: "c",
    });
  });

  it("delegates to engine.logAction when set", () => {
    const engine = createMockEngine();
    setPolicyFeedbackEngine(engine, "passive");
    logPolicyAction({
      agentId: "a",
      sessionKey: "s",
      actionType: "cron_run",
      channelId: "telegram",
    });
    expect(engine.logAction).toHaveBeenCalledOnce();
  });
});
