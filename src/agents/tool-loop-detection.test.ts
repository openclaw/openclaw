import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { wrapExternalContent } from "../security/external-content.js";
import { getCodeModeToolOutcome, recordCodeModeToolOutcome } from "./code-mode-tool-outcome.js";
import { reconcileToolCallExecutionParams } from "./tool-loop-call-reconciliation.js";
import {
  UNKNOWN_TOOL_THRESHOLD,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";
import { protectNetworkToolExecutionError } from "./tool-result-error.js";
import { jsonResult } from "./tools/common.js";

// Keep provider-send classification independent of the channel-plugin registry.
vi.mock("./embedded-agent-messaging.js", () => ({
  isMessagingToolSendAction: (toolName: string) => toolName === "telegram",
}));

const WARNING_THRESHOLD = 10;
const CRITICAL_THRESHOLD = 20;
const HISTORY_SIZE = 30;
const veto = {
  content: [{ type: "text", text: "blocked" }],
  details: { status: "blocked", deniedReason: "tool-loop" },
};
const createState = (): SessionState => ({ lastActivity: 0, state: "processing", queueDepth: 0 });

function createLoop(toolName: string, params: unknown) {
  const state = createState();
  let sequence = 0;
  function append(outcome: { result?: unknown; error?: unknown }, toolParams = params) {
    const toolCallId = `${toolName}-${sequence++}`;
    recordToolCall(state, toolName, toolParams, toolCallId);
    return recordToolCallOutcome(state, { toolName, toolParams, toolCallId, ...outcome });
  }
  return {
    state,
    record: (result: unknown, toolParams = params) => append({ result }, toolParams),
    fail: (error: unknown, toolParams = params) => append({ error }, toolParams),
    repeat(count: number, result: (index: number) => unknown, args = (_index: number) => params) {
      for (let index = 0; index < count; index++) {
        append({ result: result(index) }, args(index));
      }
    },
    detect: (toolParams = params) => detectToolCallLoop(state, toolName, toolParams),
  };
}

function argsHash(params: unknown) {
  const state = createState();
  recordToolCall(state, "browser", params);
  return state.toolCallHistory?.[0]?.argsHash;
}

function outcomeHash(text: string) {
  return recordToolCallOutcome(createState(), {
    toolName: "browser",
    toolParams: {},
    result: jsonResult({ text }),
  })?.resultHash;
}

function execResult(params: {
  status: "completed" | "failed";
  exitCode: number | null;
  output: string;
  aggregated?: string;
  timedOut?: boolean;
}) {
  return {
    content: [{ type: "text", text: params.output }],
    details: {
      status: params.status,
      exitCode: params.exitCode,
      aggregated: params.aggregated ?? params.output,
      ...(params.timedOut === undefined ? {} : { timedOut: params.timedOut }),
    },
  };
}

const writeParams = (path: string) => ({ path, content: "same content" });
function createChurn(count: number, paths = ["/a", "/b", "/a", "/a", "/b"]) {
  const loop = createLoop("write", writeParams("/a"));
  loop.repeat(
    count,
    (index) => ({
      content: [{ type: "text", text: `No changes made to ${paths[index % paths.length]}.` }],
      details: { changed: false },
    }),
    (index) => writeParams(paths[index % paths.length]!),
  );
  return loop;
}

function sendPayload(index: number) {
  return {
    ok: true,
    channel: "feishu",
    chatId: "oc_chat",
    runId: `run_${index}`,
    messageId: `om_${index}`,
    receipt: { platformMessageId: `p_${index}` },
  };
}
const sendParams = { action: "send", target: "feishu:oc_chat", text: "ping" };
function createSendLoop() {
  const loop = createLoop("message", sendParams);
  loop.repeat(CRITICAL_THRESHOLD, (index) => jsonResult(sendPayload(index)));
  return loop;
}

describe("tool-loop-detection", () => {
  it("warns only for history belonging to the current run", () => {
    const state = createState();
    const params = { path: "/same.txt" };
    for (let index = 0; index < WARNING_THRESHOLD; index++) {
      recordToolCall(state, "read", params, `call-${index}`, { runId: "run-1" });
    }
    expect(detectToolCallLoop(state, "read", params, { runId: "run-1" })).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: WARNING_THRESHOLD,
    });
    expect(detectToolCallLoop(state, "read", params, { runId: "run-2" })).toEqual({
      stuck: false,
    });
    expect(detectToolCallLoop(state, "read", params)).toEqual({ stuck: false });
  });

  it("allows calls without history", () => {
    expect(createLoop("read", {}).detect()).toEqual({ stuck: false });
  });

  it.each(["thrown", "encoded"] as const)(
    "blocks repeated external %s outcomes with fresh nonces",
    (shape) => {
      const loop = createLoop("browser", {
        action: "act",
        request: { kind: "press", key: "NotAKey" },
      });
      const delivered = new Set<string>();
      for (let index = 0; index < CRITICAL_THRESHOLD; index++) {
        const payload = 'keyboard.press: Unknown key: "NotAKey"';
        if (shape === "thrown") {
          const error = protectNetworkToolExecutionError(new Error(payload), "Failed");
          delivered.add(String(error));
          loop.fail(error);
        } else {
          let text = wrapExternalContent(payload, { source: "browser" });
          delivered.add(text);
          for (let depth = 0; depth < 4; depth++) {
            text = JSON.stringify({ text });
          }
          loop.record(jsonResult({ text, fetchedAt: "2026-08-26T00:00:00Z", tookMs: 10 }));
        }
      }
      expect(delivered.size).toBe(CRITICAL_THRESHOLD);
      expect(loop.detect()).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "generic_repeat",
      });
      const [first, second] = [...delivered];
      expect(argsHash({ text: first })).not.toBe(argsHash({ text: second }));
    },
  );

  it("preserves shallower quotes after encoded backslashes", () => {
    const hashes = [0, 1].map((index) => {
      const id = index.toString().repeat(16);
      const quote = '\\"';
      const boundary = "\\".repeat(2) + '"';
      return outcomeHash(
        `<<<EXTERNAL_UNTRUSTED_CONTENT id=${quote}${id}${quote}>>>before${boundary}after<<<END_EXTERNAL_UNTRUSTED_CONTENT id=${quote}${id}${quote}>>>`,
      );
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it.each([
    [WARNING_THRESHOLD, "warning"],
    [CRITICAL_THRESHOLD, "critical"],
  ] as const)("detects a polling loop after %i stable outcomes", (count, level) => {
    const loop = createLoop("process", { action: "poll", sessionId: "sess-1" });
    loop.repeat(count, () => ({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level,
      detector: "known_poll_no_progress",
      count,
    });
  });

  it("keeps completed churn evidence across a pending sibling while allowing novel arguments", () => {
    const loop = createChurn(HISTORY_SIZE);
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "argument_churn",
      livenessSignal: "argument_churn",
      count: HISTORY_SIZE,
    });
    recordToolCall(loop.state, "write", writeParams("/a"), "pending-sibling");
    expect(loop.detect(writeParams("/b"))).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "argument_churn",
      count: HISTORY_SIZE - 1,
    });
    expect(loop.detect(writeParams("/c"))).toEqual({ stuck: false });
  });

  it("uses the supplied threshold when reconciling rewritten calls", () => {
    const loop = createChurn(6, ["/a", "/b"]);
    recordToolCall(loop.state, "write", writeParams("/original"), "rewritten-call");
    expect(
      reconcileToolCallExecutionParams(loop.state, {
        toolName: "write",
        toolParams: writeParams("/a"),
        toolCallId: "rewritten-call",
        warningThreshold: 6,
      }),
    ).toEqual({ active: true, count: 6, variantCount: 2 });
  });

  it("does not reconcile a completed loop veto as a pending call", () => {
    const state = createState();
    state.toolCallHistory = [
      { toolName: "write", argsHash: "pending-args", timestamp: 1 },
      { toolName: "write", argsHash: "vetoed-args", outcomeKind: "tool-loop-veto", timestamp: 2 },
    ];
    expect(
      reconcileToolCallExecutionParams(state, {
        toolName: "write",
        toolParams: writeParams("/rewritten"),
        warningThreshold: 6,
      }),
    ).toEqual({ active: false, count: 0, variantCount: 0 });
    expect(state.toolCallHistory[0]?.argsHash).not.toBe("pending-args");
    expect(state.toolCallHistory[1]?.argsHash).toBe("vetoed-args");
  });

  it("preserves churn liveness when strict alternation owns the warning", () => {
    expect(createChurn(WARNING_THRESHOLD, ["/a", "/b"]).detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      livenessSignal: "argument_churn",
    });
  });

  it.each([
    {
      status: "failed",
      exitCode: 126,
      output: "Command not executable (permission denied)",
      aggregated: "",
    },
  ] as const)("blocks repeated $status failures across changing exec arguments", (testCase) => {
    const loop = createLoop("exec", { command: "python next-job.py" });
    loop.repeat(
      CRITICAL_THRESHOLD,
      () => execResult(testCase),
      (index) => ({ command: `python job-${index}.py` }),
    );
    expect(
      loop.state.toolCallHistory?.every((record) => record.outcomeKind === "terminal-exec-failure"),
    ).toBe(true);
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: CRITICAL_THRESHOLD,
    });
  });

  it("blocks terminal exec failures despite drifting diagnostic metadata", () => {
    const loop = createLoop("exec", { command: "node retry.js" });
    loop.repeat(CRITICAL_THRESHOLD, (index) =>
      execResult({
        status: "completed",
        exitCode: 1,
        output: `failed at 2026-08-30T10:20:${10 + index}Z (12:00:${10 + index}); attempt ${index}, retry=${index}, after ${index + 1}ms/${index + 1}s, pid=${1000 + index}`,
      }),
    );
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: CRITICAL_THRESHOLD,
    });
  });

  it("keeps an intervening command as a reset after the first command resumes", () => {
    const first = { command: "node first.js" };
    const loop = createLoop("exec", first);
    loop.repeat(CRITICAL_THRESHOLD - 1, (index) =>
      execResult({ status: "completed", exitCode: 1, output: `failed in pid=${1000 + index}` }),
    );
    loop.record(execResult({ status: "completed", exitCode: 1, output: "failed in pid=2000" }), {
      command: "node second.js",
    });
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
    });
    loop.record(execResult({ status: "completed", exitCode: 1, output: "failed in pid=3000" }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
    });
  });

  it("anchors changing-argument exec vetoes until the global circuit breaker", () => {
    const loop = createLoop("exec", { command: "python final-job.py" });
    loop.repeat(
      CRITICAL_THRESHOLD,
      () => execResult({ status: "completed", exitCode: 1, output: "Traceback: missing package" }),
      (index) => ({ command: `python job-${index}.py` }),
    );
    for (let index = CRITICAL_THRESHOLD; index < HISTORY_SIZE; index++) {
      const params = { command: `python job-${index}.py` };
      expect(loop.detect(params)).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "generic_repeat",
        count: index,
      });
      expect(
        recordToolCallOutcome(loop.state, {
          toolName: "exec",
          toolParams: params,
          toolCallId: `veto-${index}`,
          result: veto,
        }),
      ).toMatchObject({ outcomeKind: "tool-loop-veto", resultHash: undefined });
    }
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: HISTORY_SIZE,
    });
  });

  it.each([
    {
      label: "missing exit codes",
      status: "failed",
      exitCode: null,
      output: "process failed before spawning",
    },
  ] as const)("does not semantically block $label", (testCase) => {
    const loop = createLoop("exec", { command: "grep next-target" });
    loop.repeat(
      HISTORY_SIZE,
      () => execResult(testCase),
      (index) => ({ command: `grep target-${index}` }),
    );
    expect(loop.state.toolCallHistory?.every((record) => record.outcomeKind === undefined)).toBe(
      true,
    );
    expect(loop.detect()).toEqual({ stuck: false });
  });

  it.each(["read"])("resets the semantic failure tail after a successful %s", (toolName) => {
    const failure = execResult({
      status: "completed",
      exitCode: 1,
      output: "Traceback: missing package",
    });
    const loop = createLoop("exec", { command: "python next.py" });
    loop.repeat(
      CRITICAL_THRESHOLD - 1,
      () => failure,
      (index) => ({ command: `python job-${index}.py` }),
    );
    recordToolCallOutcome(loop.state, {
      toolName,
      toolParams: { command: "interruption" },
      toolCallId: "interruption",
      result:
        toolName === "exec"
          ? execResult({ status: "completed", exitCode: 0, output: "done" })
          : jsonResult({ ok: true }),
    });
    loop.record(failure, { command: "python latest.py" });
    expect(loop.detect()).toEqual({ stuck: false });
  });

  it("blocks running exec calls despite volatile session details and text", () => {
    const loop = createLoop("exec", { command: "tail -f /var/log/app.log", yieldMs: 1000 });
    loop.repeat(CRITICAL_THRESHOLD, (index) => ({
      content: [
        {
          type: "text",
          text: `Command still running (session sess-${index}, pid ${1000 + index})`,
        },
      ],
      details: {
        status: "running",
        sessionId: `sess-${index}`,
        pid: 1000 + index,
        startedAt: index,
        cwd: `/tmp/run-${index}`,
        tail: "(no new output)",
      },
    }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
    });
  });

  it.each(["Unknown tool: missing_a"])(
    "preserves unknown-tool evidence across loop vetoes: %s",
    (error) => {
      const loop = createLoop("tool_call", { tool: "missing_a" });
      for (let index = 0; index < UNKNOWN_TOOL_THRESHOLD; index++) {
        loop.fail(new Error(error));
      }
      loop.record(veto);
      recordToolCallOutcome(loop.state, { toolName: "read", toolParams: {}, result: veto });
      expect(loop.detect()).toMatchObject({
        stuck: true,
        detector: "unknown_tool_repeat",
        count: UNKNOWN_TOOL_THRESHOLD,
        message: expect.stringContaining("unavailable tool missing_a"),
      });
      const differentTool = { tool: "missing_b" };
      loop.fail(new Error("Unknown tool id: missing_b"), differentTool);
      expect(loop.detect(differentTool)).toEqual({ stuck: false });
    },
  );

  it.each([{ outcome: "stable", count: CRITICAL_THRESHOLD - 1, level: "critical" }])(
    "detects ping-pong with $outcome outcomes",
    ({ outcome, count, level }) => {
      const state = createState();
      for (let index = 0; index < count; index++) {
        const toolName = index % 2 === 0 ? "read" : "list";
        const params = toolName === "read" ? { path: "/a.txt" } : { dir: "/workspace" };
        const toolCallId = `${toolName}-${index}`;
        recordToolCall(state, toolName, params, toolCallId);
        if (outcome !== "missing") {
          recordToolCallOutcome(state, {
            toolName,
            toolParams: params,
            toolCallId,
            result: {
              content: [
                { type: "text", text: outcome === "stable" ? toolName : `${toolName} ${index}` },
              ],
              details: { ok: true },
            },
          });
        }
      }
      expect(detectToolCallLoop(state, "list", { dir: "/workspace" })).toMatchObject({
        stuck: true,
        level,
        detector: "ping_pong",
        count: count + 1,
      });
    },
  );

  it("records bounded hashes for process log outcomes", () => {
    const loop = createLoop("process", { action: "log", sessionId: "sess-big" });
    const recorded = loop.record({
      content: [{ type: "text", text: "y".repeat(40_000) }],
      details: { status: "running", totalLines: 1, totalChars: 40_000 },
    });
    expect(recorded?.resultHash).toHaveLength(64);
  });

  it("keeps only bounded Code Mode identities across 2,000 retained receipts", () => {
    const loop = createLoop("exec", { code: "return result;" });
    const receipts: object[] = [];
    let retainedBytes = 0;
    for (let index = 0; index < 2_000; index++) {
      const payload = {
        status: "completed",
        value: wrapExternalContent("same result ".repeat(512), { source: "browser" }),
        telemetry: { callCount: index },
      };
      const receipt = recordCodeModeToolOutcome({}, payload);
      receipts.push(receipt);
      retainedBytes += Buffer.byteLength(getCodeModeToolOutcome(receipt)!);
      loop.record(receipt);
    }
    expect(retainedBytes).toBeLessThanOrEqual(receipts.length * 64);
    expect(loop.state.toolCallHistory).toHaveLength(HISTORY_SIZE);
    expect(loop.detect()).toMatchObject({ stuck: true, level: "critical" });
    loop.record(recordCodeModeToolOutcome({}, { status: "completed", value: "new result" }));
    expect(loop.detect()).not.toMatchObject({ level: "critical" });
  });

  it("does not attach outcomes to matching calls from another run", () => {
    const state = createState();
    const params = { path: "/same.txt" };
    recordToolCall(state, "read", params, "call-1", { runId: "run-1" });
    recordToolCallOutcome(state, {
      toolName: "read",
      toolParams: params,
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "same output" }] },
      runId: "run-2",
    });
    expect(state.toolCallHistory).toHaveLength(2);
    expect(state.toolCallHistory?.[0]?.resultHash).toBeUndefined();
    expect(state.toolCallHistory?.[1]?.runId).toBe("run-2");
    expect(state.toolCallHistory?.[1]?.resultHash).toBeTypeOf("string");
  });

  it("blocks broadcast loops despite fresh nested delivery IDs", () => {
    const loop = createLoop("message", { action: "broadcast", text: "ping" });
    loop.repeat(CRITICAL_THRESHOLD, (index) =>
      jsonResult({
        results: [
          { channel: "feishu", ok: true, result: { messageId: `om_${index}`, receipt: index } },
        ],
      }),
    );
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
    });
  });

  it.each([["sessions_send", { sessionKey: "agent:main:peer", text: "ping" }]] as const)(
    "blocks %s loops despite fresh delivery IDs",
    (toolName, params) => {
      const loop = createLoop(toolName, params);
      loop.repeat(CRITICAL_THRESHOLD, (index) => jsonResult(sendPayload(index)));
      expect(loop.detect()).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "generic_repeat",
      });
    },
  );

  it("does not count unrelated hashless calls as no-progress outcomes", () => {
    const loop = createSendLoop();
    for (let index = CRITICAL_THRESHOLD; index < HISTORY_SIZE; index++) {
      recordToolCall(loop.state, "message", sendParams, `pending-${index}`);
    }
    expect(loop.detect()).toMatchObject({
      stuck: true,
      detector: "generic_repeat",
      count: CRITICAL_THRESHOLD,
    });
  });

  it("does not carry older loop vetoes across a later progressing outcome", () => {
    const loop = createSendLoop();
    for (let index = 0; index < 5; index++) {
      recordToolCallOutcome(loop.state, {
        toolName: "message",
        toolParams: sendParams,
        toolCallId: `old-veto-${index}`,
        result: veto,
      });
    }
    loop.record(jsonResult({ ...sendPayload(25), route: { id: "new-route" } }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: 26,
    });
  });

  it("blocks plugin-shaped sends with a bare per-send message ID", () => {
    const loop = createLoop("message", { action: "send", to: "feishu:chat-1", content: "hello" });
    loop.repeat(CRITICAL_THRESHOLD, (index) =>
      jsonResult({
        message: {
          id: `qa_${index}`,
          accountId: "default",
          direction: "outbound",
          senderId: "openclaw",
          conversation: { id: "loop-room", chatType: "channel" },
          text: "hello",
          timestamp: 1_800_000_000_000 + index,
        },
      }),
    );
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
    });
  });

  it("preserves conversation changes as progress between sends", () => {
    const loop = createLoop("message", { action: "send", to: "feishu:chat-1", content: "hello" });
    loop.repeat(CRITICAL_THRESHOLD, (index) =>
      jsonResult({
        message: {
          id: `qa_${index}`,
          direction: "outbound",
          conversation: { id: `loop-room-${index}`, chatType: "channel" },
          text: "hello",
        },
      }),
    );
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
    });
  });
});
