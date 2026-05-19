// P2.12 tool-call loop guard (gemma-memory follow-up).
// Verifies the generic_repeat blocking escalation + env knobs against the
// real detectToolCallLoop / recordToolCall API, including the exact runaway
// argument payloads observed in the 2026-05-19 22:38 KST gemma jsonl.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  type LoopDetectionResult,
  detectToolCallLoop,
  recordToolCall,
} from "./tool-loop-detection.js";

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

const ENABLED: ToolLoopDetectionConfig = { enabled: true };

/**
 * Mirror the real before-tool-call flow: detect first (current call not yet
 * recorded), then record the call. Returns each call's detection result.
 */
function simulateCalls(
  state: SessionState,
  calls: Array<{ tool: string; args: unknown }>,
  config: ToolLoopDetectionConfig = ENABLED,
): LoopDetectionResult[] {
  const results: LoopDetectionResult[] = [];
  calls.forEach((call, i) => {
    const result = detectToolCallLoop(state, call.tool, call.args, config);
    results.push(result);
    recordToolCall(state, call.tool, call.args, `${call.tool}-${i}`, config);
  });
  return results;
}

function repeat(tool: string, args: unknown, n: number) {
  return Array.from({ length: n }, () => ({ tool, args }));
}

// Exact runaway payloads from the gemma session jsonl
// (e8d2bd03-3cee-48d5-b380-4bdc1dc92756, 2026-05-19).
const HWANG_EXEC_ARGS = {
  command: '<|<|"grep -r "황선아" claude-ref/ 2>/dev/null || echo "Not found',
};
const JOURNAL_EXEC_ARGS = { command: '<<|"|>ls -ls -l journal/2026-05-18*' };
const READ_SENTINEL_ARGS = { file_path: '<|"|' };

const GUARD_ENV_KEYS = [
  "OPENCLAW_TOOL_LOOP_GUARD_DISABLED",
  "OPENCLAW_TOOL_LOOP_GUARD_ENABLED",
  "OPENCLAW_TOOL_LOOP_GUARD_WINDOW",
] as const;

describe("P2.12 tool-call loop guard", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of GUARD_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of GUARD_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("case 1: distinct args never block", () => {
    const state = createState();
    const results = simulateCalls(
      state,
      ["a", "b", "c", "d", "e"].map((c) => ({ tool: "exec", args: { command: c } })),
    );
    expect(results.every((r) => !r.stuck)).toBe(true);
  });

  it("case 2: identical args block on the 5th call", () => {
    const state = createState();
    const results = simulateCalls(state, repeat("exec", { command: "a" }, 5));

    expect(results.slice(0, 4).every((r) => !r.stuck)).toBe(true);
    const fifth = results[4];
    expect(fifth?.stuck).toBe(true);
    if (fifth?.stuck) {
      expect(fifth.level).toBe("critical");
      expect(fifth.detector).toBe("generic_repeat");
      expect(fifth.count).toBe(5);
    }
  });

  it("case 3: 4 identical + 1 different — the different 5th call is not blocked", () => {
    const state = createState();
    const calls = [
      ...repeat("exec", { command: "a" }, 4),
      { tool: "exec", args: { command: "b" } },
    ];
    const results = simulateCalls(state, calls);
    expect(results.every((r) => !r.stuck)).toBe(true);
  });

  it("case 4: 황선아 grep runaway args block on the 5th call", () => {
    const state = createState();
    const results = simulateCalls(state, repeat("exec", HWANG_EXEC_ARGS, 5));
    expect(results.slice(0, 4).every((r) => !r.stuck)).toBe(true);
    expect(results[4]?.stuck).toBe(true);
    const fifth = results[4];
    if (fifth?.stuck) {
      expect(fifth.level).toBe("critical");
    }
  });

  it("case 5: journal ls runaway args block on the 5th call", () => {
    const state = createState();
    const results = simulateCalls(state, repeat("exec", JOURNAL_EXEC_ARGS, 5));
    expect(results[4]?.stuck).toBe(true);
  });

  it("case 6: read sentinel-only args block on the 5th call", () => {
    const state = createState();
    const results = simulateCalls(state, repeat("read", READ_SENTINEL_ARGS, 5));
    expect(results.slice(0, 4).every((r) => !r.stuck)).toBe(true);
    expect(results[4]?.stuck).toBe(true);
  });

  it("case 7: different tools with low counts are not blocked", () => {
    const state = createState();
    const calls = [
      ...repeat("exec", { command: "a" }, 3),
      ...repeat("read", { file_path: "a" }, 3),
    ];
    const results = simulateCalls(state, calls);
    expect(results.every((r) => !r.stuck)).toBe(true);
  });

  it("case 8: OPENCLAW_TOOL_LOOP_GUARD_WINDOW=2 blocks on the 3rd call", () => {
    process.env.OPENCLAW_TOOL_LOOP_GUARD_WINDOW = "2";
    const state = createState();
    const results = simulateCalls(state, repeat("exec", { command: "a" }, 3));
    expect(results[0]?.stuck).toBe(false);
    expect(results[1]?.stuck).toBe(false);
    const third = results[2];
    expect(third?.stuck).toBe(true);
    if (third?.stuck) {
      expect(third.count).toBe(3);
    }
  });

  it("env: OPENCLAW_TOOL_LOOP_GUARD_DISABLED forces the guard off", () => {
    process.env.OPENCLAW_TOOL_LOOP_GUARD_DISABLED = "true";
    const state = createState();
    const results = simulateCalls(state, repeat("exec", { command: "a" }, 10));
    expect(results.every((r) => !r.stuck)).toBe(true);
  });

  it("env: OPENCLAW_TOOL_LOOP_GUARD_ENABLED activates without config", () => {
    process.env.OPENCLAW_TOOL_LOOP_GUARD_ENABLED = "1";
    const state = createState();
    // No config passed at all -> default would be disabled; env turns it on.
    const results: LoopDetectionResult[] = [];
    repeat("exec", { command: "a" }, 5).forEach((call, i) => {
      results.push(detectToolCallLoop(state, call.tool, call.args));
      recordToolCall(state, call.tool, call.args, `exec-${i}`);
    });
    expect(results[4]?.stuck).toBe(true);
  });

  it("disabled config (default) never blocks even on heavy repetition", () => {
    const state = createState();
    const results: LoopDetectionResult[] = [];
    repeat("exec", { command: "a" }, 12).forEach((call, i) => {
      results.push(detectToolCallLoop(state, call.tool, call.args));
      recordToolCall(state, call.tool, call.args, `exec-${i}`);
    });
    expect(results.every((r) => !r.stuck)).toBe(true);
  });
});
