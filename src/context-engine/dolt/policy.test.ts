import { describe, expect, it } from "vitest";
import {
  DOLT_LANE_POLICIES_DEFAULT,
  DOLT_OUTLIER_INTERCEPT_TOKEN_LIMIT,
  evaluateDoltLanePressure,
  interceptDoltTurnPayloadForAccounting,
  resolveDoltLanePolicies,
  selectDoltTurnChunkForCompaction,
} from "./policy.js";
import { estimateDoltTokenCount } from "./store/token-count.js";

describe("resolveDoltLanePolicies", () => {
  it("returns defaults and applies overrides per lane", () => {
    const resolved = resolveDoltLanePolicies({
      turn: { soft: 41_000 },
      bindle: { summaryCap: 1_700 },
    });

    expect(resolved.turn).toEqual({
      soft: 41_000,
      delta: 4_000,
      target: 36_000,
    });
    expect(resolved.leaf).toEqual(DOLT_LANE_POLICIES_DEFAULT.leaf);
    expect(resolved.bindle).toEqual({
      soft: 10_000,
      delta: 1_000,
      target: 9_000,
      summaryCap: 1_700,
    });
  });
});

describe("evaluateDoltLanePressure", () => {
  it("triggers normal compaction only above soft+delta", () => {
    const policy = DOLT_LANE_POLICIES_DEFAULT.turn;

    const below = evaluateDoltLanePressure({
      laneTokenCount: policy.soft + policy.delta,
      policy,
      drainMode: false,
      hardLimitSafetyMode: false,
    });
    const above = evaluateDoltLanePressure({
      laneTokenCount: policy.soft + policy.delta + 1,
      policy,
      drainMode: false,
      hardLimitSafetyMode: false,
    });

    expect(below).toMatchObject({ shouldCompact: false, trigger: "none" });
    expect(above).toMatchObject({
      shouldCompact: true,
      trigger: "soft_delta",
      nextDrainMode: true,
    });
  });

  it("uses hard-limit bypass when enabled and lane exceeds target", () => {
    const policy = DOLT_LANE_POLICIES_DEFAULT.turn;
    const result = evaluateDoltLanePressure({
      laneTokenCount: policy.target + 1,
      policy,
      drainMode: false,
      hardLimitSafetyMode: true,
    });

    expect(result).toMatchObject({
      shouldCompact: true,
      trigger: "hard_limit_bypass",
      nextDrainMode: true,
    });
  });

  it("continues draining until lane drops to target", () => {
    const policy = DOLT_LANE_POLICIES_DEFAULT.turn;
    const continueDrain = evaluateDoltLanePressure({
      laneTokenCount: policy.target + 50,
      policy,
      drainMode: true,
      hardLimitSafetyMode: false,
    });
    const stopDrain = evaluateDoltLanePressure({
      laneTokenCount: policy.target,
      policy,
      drainMode: true,
      hardLimitSafetyMode: false,
    });

    expect(continueDrain).toMatchObject({
      shouldCompact: true,
      trigger: "drain",
      nextDrainMode: true,
    });
    expect(stopDrain).toMatchObject({
      shouldCompact: false,
      trigger: "none",
      nextDrainMode: false,
    });
  });
});

describe("selectDoltTurnChunkForCompaction", () => {
  it("sizes chunks dynamically from pressure delta and preserves fresh tail", () => {
    const policy = DOLT_LANE_POLICIES_DEFAULT.turn;
    const turns = [
      { pointer: "turn-1", tokenCount: 3_000 },
      { pointer: "turn-2", tokenCount: 3_000 },
      { pointer: "turn-3", tokenCount: 3_000 },
      { pointer: "turn-4", tokenCount: 3_000 },
      { pointer: "turn-5", tokenCount: 3_000 },
      { pointer: "turn-6", tokenCount: 3_000 },
      { pointer: "turn-7", tokenCount: 3_000 },
      { pointer: "turn-8", tokenCount: 3_000 },
      { pointer: "turn-9", tokenCount: 3_000 },
      { pointer: "turn-10", tokenCount: 3_000 },
      { pointer: "turn-11", tokenCount: 3_000 },
      { pointer: "turn-12", tokenCount: 3_000 },
      { pointer: "turn-13", tokenCount: 3_000 },
      { pointer: "turn-14", tokenCount: 3_000 },
      { pointer: "turn-15", tokenCount: 3_000 },
      { pointer: "turn-16", tokenCount: 3_000 },
      { pointer: "turn-17", tokenCount: 3_000 },
      { pointer: "turn-18", tokenCount: 3_000 },
    ];

    const laneTokenCount = turns.reduce((sum, turn) => sum + turn.tokenCount, 0);
    const selection = selectDoltTurnChunkForCompaction({
      turns,
      laneTokenCount,
      policy,
    });

    expect(selection.freshTailCount).toBe(3);
    expect(selection.selectedCount).toBe(6);
    expect(selection.selected.map((turn) => turn.pointer)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
      "turn-6",
    ]);
  });

  it("keeps exactly two fresh-tail turns when two recent turns exceed 10k", () => {
    const selection = selectDoltTurnChunkForCompaction({
      turns: [
        { pointer: "old-a", tokenCount: 3_000 },
        { pointer: "old-b", tokenCount: 3_000 },
        { pointer: "tail-a", tokenCount: 5_500 },
        { pointer: "tail-b", tokenCount: 5_500 },
      ],
      laneTokenCount: 17_000,
      policy: DOLT_LANE_POLICIES_DEFAULT.turn,
    });

    expect(selection.freshTailCount).toBe(2);
    expect(selection.selected.map((turn) => turn.pointer)).toEqual(["old-a", "old-b"]);
  });

  it("keeps many small turns when fresh-tail window stays under 10k", () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({
      pointer: `turn-${index + 1}`,
      tokenCount: 400,
    }));
    const laneTokenCount = turns.reduce((sum, turn) => sum + turn.tokenCount, 0);
    const selection = selectDoltTurnChunkForCompaction({
      turns,
      laneTokenCount,
      policy: DOLT_LANE_POLICIES_DEFAULT.turn,
    });

    expect(selection.freshTailCount).toBe(25);
    expect(selection.maxSelectableCount).toBe(5);
    expect(selection.selected.length).toBeGreaterThan(0);
    expect(selection.selected.some((turn) => turn.pointer === "turn-26")).toBe(false);
  });

  it("keeps two-turn minimum fresh tail when newest outlier alone exceeds 10k", () => {
    const selection = selectDoltTurnChunkForCompaction({
      turns: [
        { pointer: "old-1", tokenCount: 2_500 },
        { pointer: "old-2", tokenCount: 2_500 },
        { pointer: "near-tail", tokenCount: 800 },
        { pointer: "outlier", tokenCount: 11_500 },
      ],
      laneTokenCount: 17_300,
      policy: DOLT_LANE_POLICIES_DEFAULT.turn,
    });

    expect(selection.freshTailCount).toBe(2);
    expect(selection.selected.map((turn) => turn.pointer)).toEqual(["old-1", "old-2"]);
  });

  it("enforces minimum chunk floor of two turns", () => {
    const selection = selectDoltTurnChunkForCompaction({
      turns: [
        { pointer: "old-1", tokenCount: 500 },
        { pointer: "old-2", tokenCount: 500 },
        { pointer: "tail-1", tokenCount: 6_000 },
        { pointer: "tail-2", tokenCount: 6_000 },
      ],
      laneTokenCount: 38_000,
      policy: DOLT_LANE_POLICIES_DEFAULT.turn,
    });

    expect(selection.selectedCount).toBe(2);
    expect(selection.selected.map((turn) => turn.pointer)).toEqual(["old-1", "old-2"]);
  });
});

describe("interceptDoltTurnPayloadForAccounting", () => {
  it("returns payload unchanged when below interception threshold", () => {
    const payload = { role: "assistant", content: "short" };
    const result = interceptDoltTurnPayloadForAccounting({ payload });

    expect(result.intercepted).toBe(false);
    expect(result.payload).toBe(payload);
  });

  it("intercepts oversized payloads and reduces accounting token footprint", () => {
    const hugePayload = {
      role: "tool",
      content: "x".repeat(60_000),
    };

    const raw = estimateDoltTokenCount({ payload: hugePayload });
    expect(raw.tokenCount).toBeGreaterThan(DOLT_OUTLIER_INTERCEPT_TOKEN_LIMIT);

    const intercepted = interceptDoltTurnPayloadForAccounting({ payload: hugePayload });
    const interceptedCount = estimateDoltTokenCount({ payload: intercepted.payload });

    expect(intercepted.intercepted).toBe(true);
    expect(intercepted.sourceTokenEstimate).toBe(raw.tokenCount);
    expect(interceptedCount.tokenCount).toBeLessThan(raw.tokenCount);

    const metadata = (intercepted.payload as { doltAccountingIntercept?: Record<string, unknown> })
      .doltAccountingIntercept;
    expect(metadata?.reason).toBe("oversized_turn_payload");
    expect(metadata?.sourceTokenEstimate).toBe(raw.tokenCount);
    expect(typeof metadata?.payloadSha256).toBe("string");
  });
});
