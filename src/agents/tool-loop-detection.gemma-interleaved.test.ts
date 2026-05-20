// P2.15 follow-up: the 12:25 KST 2026-05-20 gemma session showed a runaway
// where the same `exec({command: "bash scripts/memory.sh search 정유진"})` was
// issued 6 times in a single response, but each pair was separated by a
// variant call (a different exec command or a different tool entirely). The
// P2.12 trailing-consecutive-run detector reset on every interleaved call and
// never fired. These tests pin the windowed-occurrence shape so that pattern
// blocks on the 5th identical call regardless of interleaving.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  type LoopDetectionResult,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

const ENABLED: ToolLoopDetectionConfig = { enabled: true };

const GEMMA_RUNAWAY_ARGS = { command: "bash scripts/memory.sh search 정유진" };
const GEMMA_RUNAWAY_RESULT = {
  content: [
    {
      type: "text",
      text: "people/민주.md: → **본명: 정유진** — [정유진.md](정유진.md)",
    },
  ],
  details: { status: "completed", exitCode: 0, aggregated: "people/민주.md…" },
};

// Variant calls observed in the real session between identical runaway calls.
const VARIANT_CALLS: Array<{ tool: string; args: unknown; result: unknown }> = [
  {
    tool: "exec",
    args: { command: "bash scripts/memory.sh on 2026-05-19" },
    result: {
      content: [{ type: "text", text: "RESULT: FAILED" }],
      details: { exitCode: 1 },
    },
  },
  {
    tool: "exec",
    args: { command: 'bash scripts/memory.sh search 정유진 | grep -A 20 "정유진.md' },
    result: {
      content: [
        {
          type: "text",
          text: "/bin/bash: -c: line 1: unexpected EOF while looking for matching `\"'",
        },
      ],
      details: { exitCode: 2 },
    },
  },
  {
    tool: "read",
    args: { file_path: "<|<|" },
    result: {
      content: [
        {
          type: "text",
          text: '{"status":"error","tool":"read","error":"Missing required parameter"}',
        },
      ],
      details: { status: "error" },
    },
  },
  {
    tool: "exec",
    args: {
      command: 'bash scripts/memory.sh search 정유진 | grep "정유진.md" | head -n 1',
    },
    result: {
      content: [
        {
          type: "text",
          text: "people/민주.md: → **본명: 정유진** — [정유진.md](정유진.md)",
        },
      ],
      details: { status: "completed", exitCode: 0 },
    },
  },
];

const GUARD_ENV_KEYS = [
  "OPENCLAW_TOOL_LOOP_GUARD_DISABLED",
  "OPENCLAW_TOOL_LOOP_GUARD_ENABLED",
  "OPENCLAW_TOOL_LOOP_GUARD_WINDOW",
] as const;

describe("P2.15 generic_repeat block: gemma-style interleaved runaway", () => {
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

  it("blocks the 5th identical exec call even with variant calls interleaved between each repeat (real gemma jsonl pattern)", () => {
    const state = createState();
    // Sequence: A, X1, A, X2, A, X3, A, X4, A   (5 A's, 4 distinct variants)
    const sequence: Array<{ tool: string; args: unknown; result?: unknown }> = [];
    for (let i = 0; i < 4; i += 1) {
      sequence.push({ tool: "exec", args: GEMMA_RUNAWAY_ARGS, result: GEMMA_RUNAWAY_RESULT });
      const variant = VARIANT_CALLS[i];
      if (variant) {
        sequence.push(variant);
      }
    }
    // The 5th A — detect should block this one BEFORE we record/execute it.
    sequence.push({ tool: "exec", args: GEMMA_RUNAWAY_ARGS, result: GEMMA_RUNAWAY_RESULT });

    const results: LoopDetectionResult[] = [];
    sequence.forEach((call, i) => {
      const detection = detectToolCallLoop(state, call.tool, call.args, ENABLED);
      results.push(detection);
      const toolCallId = `${call.tool}-${i}`;
      recordToolCall(state, call.tool, call.args, toolCallId, ENABLED);
      if (call.result !== undefined) {
        recordToolCallOutcome(state, {
          toolName: call.tool,
          toolParams: call.args,
          toolCallId,
          result: call.result,
          config: ENABLED,
        });
      }
    });

    // First 8 calls (4 A's + 4 variants) should not block.
    expect(results.slice(0, 8).every((r) => !r.stuck)).toBe(true);
    // 9th call (the 5th A) must block under generic_repeat.
    const fifthA = results.at(-1);
    expect(fifthA?.stuck).toBe(true);
    if (fifthA?.stuck) {
      expect(fifthA.level).toBe("critical");
      expect(fifthA.detector).toBe("generic_repeat");
      expect(fifthA.count).toBe(5);
    }
  });

  it("blocks every subsequent identical attempt after the block fires (backstop for runaway models)", () => {
    const state = createState();
    // Pre-populate: 4 A's + 4 variants
    for (let i = 0; i < 4; i += 1) {
      detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS, ENABLED);
      recordToolCall(state, "exec", GEMMA_RUNAWAY_ARGS, `a-${i}`, ENABLED);
      recordToolCallOutcome(state, {
        toolName: "exec",
        toolParams: GEMMA_RUNAWAY_ARGS,
        toolCallId: `a-${i}`,
        result: GEMMA_RUNAWAY_RESULT,
        config: ENABLED,
      });
      const variant = VARIANT_CALLS[i];
      if (variant) {
        detectToolCallLoop(state, variant.tool, variant.args, ENABLED);
        recordToolCall(state, variant.tool, variant.args, `v-${i}`, ENABLED);
        recordToolCallOutcome(state, {
          toolName: variant.tool,
          toolParams: variant.args,
          toolCallId: `v-${i}`,
          result: variant.result,
          config: ENABLED,
        });
      }
    }
    // Two more attempts at A — both must block.
    const fifth = detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS, ENABLED);
    expect(fifth.stuck).toBe(true);
    // Even if the model didn't get to execute it (no record), detection on a
    // subsequent attempt with no further state change must still block.
    const sixth = detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS, ENABLED);
    expect(sixth.stuck).toBe(true);
  });

  it("does not block when the same (tool, args) returns *different* results each time (model is making progress)", () => {
    const state = createState();
    // 5 identical exec calls but each returns a different resultHash.
    for (let i = 0; i < 4; i += 1) {
      const detection = detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS, ENABLED);
      expect(detection.stuck).toBe(false);
      recordToolCall(state, "exec", GEMMA_RUNAWAY_ARGS, `p-${i}`, ENABLED);
      recordToolCallOutcome(state, {
        toolName: "exec",
        toolParams: GEMMA_RUNAWAY_ARGS,
        toolCallId: `p-${i}`,
        result: {
          content: [{ type: "text", text: `progress ${i}` }],
          details: { status: "completed", exitCode: 0 },
        },
        config: ENABLED,
      });
    }
    // The 5th attempt must NOT block — distinct resultHashes prove progress.
    const fifth = detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS, ENABLED);
    expect(fifth.stuck).toBe(false);
  });

  it("env-only activation (no config) still blocks the gemma interleaved pattern", () => {
    process.env.OPENCLAW_TOOL_LOOP_GUARD_ENABLED = "1";
    const state = createState();
    for (let i = 0; i < 4; i += 1) {
      detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS);
      recordToolCall(state, "exec", GEMMA_RUNAWAY_ARGS, `a-${i}`);
      recordToolCallOutcome(state, {
        toolName: "exec",
        toolParams: GEMMA_RUNAWAY_ARGS,
        toolCallId: `a-${i}`,
        result: GEMMA_RUNAWAY_RESULT,
      });
      const variant = VARIANT_CALLS[i];
      if (variant) {
        detectToolCallLoop(state, variant.tool, variant.args);
        recordToolCall(state, variant.tool, variant.args, `v-${i}`);
        recordToolCallOutcome(state, {
          toolName: variant.tool,
          toolParams: variant.args,
          toolCallId: `v-${i}`,
          result: variant.result,
        });
      }
    }
    const fifth = detectToolCallLoop(state, "exec", GEMMA_RUNAWAY_ARGS);
    expect(fifth.stuck).toBe(true);
    if (fifth.stuck) {
      expect(fifth.detector).toBe("generic_repeat");
    }
  });
});
