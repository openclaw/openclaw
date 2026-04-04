import { describe, expect, test, beforeEach } from "vitest";
import { onAgentEvent, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { TurnSummaryBuilder } from "../infra/turn-summary.js";
import { TurnRecorder, type TurnFixture } from "../test-utils/turn-recorder.js";
import { replayTurnFixture } from "../test-utils/turn-replayer.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeFixture(
  entries: TurnFixture["entries"],
  overrides?: Partial<TurnFixture>,
): TurnFixture {
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    entries,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("turn-replay-parity", () => {
  beforeEach(() => {
    resetAgentRunContextForTest();
    resetDiagnosticEventsForTest();
  });

  // ── Scenario 1: Simple reply (no tool calls) ───────────────────────

  test("scenario 1: simple reply — lifecycle start + assistant + lifecycle end", () => {
    const fixture = makeFixture([
      {
        kind: "agent",
        event: {
          runId: "run-1",
          seq: 1,
          ts: 1000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1000 },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-1",
          seq: 2,
          ts: 1050,
          stream: "assistant",
          data: { text: "Hello, world!" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-1",
          seq: 3,
          ts: 1100,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 1000, endedAt: 1100 },
        },
      },
      {
        kind: "diagnostic",
        event: {
          type: "turn.completed",
          seq: 1,
          ts: 1100,
          turnId: "turn-1",
          runId: "run-1",
          durationMs: 100,
          iterations: 1,
          toolCallCount: 0,
          toolErrors: 0,
          outcome: "success",
        },
      },
    ]);

    const agentStreams: string[] = [];
    const diagTypes: string[] = [];
    const cleanupA = onAgentEvent((evt) => agentStreams.push(evt.stream));
    const cleanupD = onDiagnosticEvent((evt) => diagTypes.push(evt.type));

    const result = replayTurnFixture(fixture);

    cleanupA();
    cleanupD();

    expect(result.entriesReplayed).toBe(4);
    expect(result.agentEvents).toBe(3);
    expect(result.diagnosticEvents).toBe(1);
    expect(agentStreams).toEqual(["lifecycle", "assistant", "lifecycle"]);
    expect(diagTypes).toEqual(["turn.completed"]);
  });

  // ── Scenario 2: Single tool call ───────────────────────────────────

  test("scenario 2: single tool call — tool start + tool end + assistant", () => {
    const fixture = makeFixture([
      {
        kind: "agent",
        event: {
          runId: "run-2",
          seq: 1,
          ts: 2000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 2000 },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-2",
          seq: 2,
          ts: 2010,
          stream: "tool",
          data: { phase: "start", tool: "web_search", callId: "call-1" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-2",
          seq: 3,
          ts: 2500,
          stream: "tool",
          data: { phase: "end", tool: "web_search", callId: "call-1" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-2",
          seq: 4,
          ts: 2600,
          stream: "assistant",
          data: { text: "I found some results." },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-2",
          seq: 5,
          ts: 2700,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 2000, endedAt: 2700 },
        },
      },
    ]);

    const toolPhases: string[] = [];
    const cleanupA = onAgentEvent((evt) => {
      if (evt.stream === "tool" && typeof evt.data.phase === "string") {
        toolPhases.push(evt.data.phase);
      }
    });

    const result = replayTurnFixture(fixture);
    cleanupA();

    expect(result.agentEvents).toBe(5);
    expect(toolPhases).toEqual(["start", "end"]);
  });

  // ── Scenario 3: Multi-tool chain ──────────────────────────────────

  test("scenario 3: multi-tool chain — three sequential tool calls", () => {
    const tools = ["read_file", "edit_file", "run_tests"];
    const entries: TurnFixture["entries"] = [
      {
        kind: "agent",
        event: {
          runId: "run-3",
          seq: 1,
          ts: 3000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 3000 },
        },
      },
    ];
    let seq = 2;
    for (const tool of tools) {
      entries.push({
        kind: "agent",
        event: {
          runId: "run-3",
          seq: seq++,
          ts: 3000 + seq * 100,
          stream: "tool",
          data: { phase: "start", tool, callId: `call-${tool}` },
        },
      });
      entries.push({
        kind: "agent",
        event: {
          runId: "run-3",
          seq: seq++,
          ts: 3000 + seq * 100,
          stream: "tool",
          data: { phase: "end", tool, callId: `call-${tool}` },
        },
      });
    }
    entries.push({
      kind: "agent",
      event: {
        runId: "run-3",
        seq: seq++,
        ts: 4000,
        stream: "assistant",
        data: { text: "All done!" },
      },
    });
    entries.push({
      kind: "agent",
      event: {
        runId: "run-3",
        seq: seq,
        ts: 4100,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 3000, endedAt: 4100 },
      },
    });

    const fixture = makeFixture(entries);

    const toolNames: string[] = [];
    const cleanupA = onAgentEvent((evt) => {
      if (
        evt.stream === "tool" &&
        evt.data.phase === "start" &&
        typeof evt.data.tool === "string"
      ) {
        toolNames.push(evt.data.tool);
      }
    });

    const result = replayTurnFixture(fixture);
    cleanupA();

    expect(result.agentEvents).toBe(entries.length);
    expect(toolNames).toEqual(["read_file", "edit_file", "run_tests"]);
  });

  // ── Scenario 4: Tool error recovery ───────────────────────────────

  test("scenario 4: tool error recovery — first call fails, second succeeds", () => {
    const fixture = makeFixture([
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 1,
          ts: 4000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 4000 },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 2,
          ts: 4010,
          stream: "tool",
          data: { phase: "start", tool: "bash", callId: "call-err" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 3,
          ts: 4200,
          stream: "tool",
          data: { phase: "end", tool: "bash", callId: "call-err", error: "exit code 1" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 4,
          ts: 4300,
          stream: "tool",
          data: { phase: "start", tool: "bash", callId: "call-ok" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 5,
          ts: 4500,
          stream: "tool",
          data: { phase: "end", tool: "bash", callId: "call-ok" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 6,
          ts: 4600,
          stream: "assistant",
          data: { text: "Fixed the issue and retried successfully." },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-4",
          seq: 7,
          ts: 4700,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 4000, endedAt: 4700 },
        },
      },
      {
        kind: "diagnostic",
        event: {
          type: "turn.completed",
          seq: 1,
          ts: 4700,
          turnId: "turn-4",
          runId: "run-4",
          durationMs: 700,
          iterations: 2,
          toolCallCount: 2,
          toolErrors: 1,
          outcome: "success",
        },
      },
    ]);

    const diagEvents: DiagnosticEventPayload[] = [];
    const cleanupD = onDiagnosticEvent((evt) => diagEvents.push(evt));

    const result = replayTurnFixture(fixture);
    cleanupD();

    expect(result.diagnosticEvents).toBe(1);
    const turnEvt = diagEvents.find((e) => e.type === "turn.completed");
    expect(turnEvt).toBeDefined();
    if (turnEvt?.type === "turn.completed") {
      expect(turnEvt.toolErrors).toBe(1);
      expect(turnEvt.toolCallCount).toBe(2);
      expect(turnEvt.outcome).toBe("success");
    }
  });

  // ── Scenario 5: Context overflow / compaction ─────────────────────

  test("scenario 5: context overflow triggers compaction outcome", () => {
    const fixture = makeFixture([
      {
        kind: "agent",
        event: {
          runId: "run-5",
          seq: 1,
          ts: 5000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 5000 },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-5",
          seq: 2,
          ts: 5010,
          stream: "compaction",
          data: { phase: "start" },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-5",
          seq: 3,
          ts: 5500,
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-5",
          seq: 4,
          ts: 5600,
          stream: "assistant",
          data: { text: "Compacted and continuing." },
        },
      },
      {
        kind: "agent",
        event: {
          runId: "run-5",
          seq: 5,
          ts: 5700,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 5000, endedAt: 5700 },
        },
      },
      {
        kind: "diagnostic",
        event: {
          type: "turn.completed",
          seq: 1,
          ts: 5700,
          turnId: "turn-5",
          runId: "run-5",
          durationMs: 700,
          iterations: 1,
          toolCallCount: 0,
          toolErrors: 0,
          outcome: "compaction",
        },
      },
    ]);

    const diagEvents: DiagnosticEventPayload[] = [];
    const cleanupD = onDiagnosticEvent((evt) => diagEvents.push(evt));

    replayTurnFixture(fixture);
    cleanupD();

    const turnEvt = diagEvents.find((e) => e.type === "turn.completed");
    expect(turnEvt).toBeDefined();
    if (turnEvt?.type === "turn.completed") {
      expect(turnEvt.outcome).toBe("compaction");
      expect(turnEvt.durationMs).toBe(700);
    }
  });
});

// ─── TurnSummaryBuilder unit tests ────────────────────────────────────

describe("TurnSummaryBuilder", () => {
  test("tracks tool calls and timing", () => {
    const builder = new TurnSummaryBuilder({
      turnId: "t-1",
      runId: "r-1",
      sessionKey: "sk",
    });
    builder.incrementIterations();
    builder.recordToolStart("c1", "bash");
    builder.recordToolEnd("c1", true);
    builder.incrementIterations();
    builder.recordToolStart("c2", "web_search");
    builder.recordToolEnd("c2", false, "timeout");
    builder.setUsage({ input: 100, output: 50 });
    builder.setOutcome("success");
    const summary = builder.freeze();

    expect(summary.turnId).toBe("t-1");
    expect(summary.iterations).toBe(2);
    expect(summary.toolCalls).toHaveLength(2);
    expect(summary.toolCalls[0].name).toBe("bash");
    expect(summary.toolCalls[0].success).toBe(true);
    expect(summary.toolCalls[1].name).toBe("web_search");
    expect(summary.toolCalls[1].success).toBe(false);
    expect(summary.toolCalls[1].error).toBe("timeout");
    expect(summary.usage?.input).toBe(100);
    expect(summary.outcome).toBe("success");
    expect(typeof summary.durationMs).toBe("number");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("freeze returns a snapshot (not a mutable reference)", () => {
    const builder = new TurnSummaryBuilder({ turnId: "t-2", runId: "r-2" });
    builder.recordToolStart("c1", "foo");
    const snap = builder.freeze();
    builder.recordToolStart("c2", "bar");
    expect(snap.toolCalls).toHaveLength(1);
  });
});

// ─── TurnRecorder unit tests ──────────────────────────────────────────

describe("TurnRecorder", () => {
  beforeEach(() => {
    resetAgentRunContextForTest();
    resetDiagnosticEventsForTest();
  });

  test("captures and stops cleanly", async () => {
    const recorder = new TurnRecorder();
    recorder.start();

    // Simulate some events via the emitters
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    const { emitDiagnosticEvent } = await import("../infra/diagnostic-events.js");

    emitAgentEvent({
      runId: "rec-run-1",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emitDiagnosticEvent({
      type: "turn.started",
      turnId: "rec-turn-1",
      runId: "rec-run-1",
    });

    const fixture = recorder.stop();

    expect(fixture.version).toBe(1);
    expect(fixture.entries).toHaveLength(2);
    expect(fixture.entries[0].kind).toBe("agent");
    expect(fixture.entries[1].kind).toBe("diagnostic");

    // After stop, no more events should be captured
    emitAgentEvent({
      runId: "rec-run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    expect(fixture.entries).toHaveLength(2);
  });
});
