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

  it("preserves marker pairs split across encoded JSON fields", () => {
    const hashes = [0, 1].map((index) => {
      const id = index.toString().repeat(16);
      const text = JSON.stringify({
        start: `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: Browser\n---\npayload`,
        end: `\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
      });
      return outcomeHash(JSON.stringify({ text }));
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("preserves long backslash payloads while normalizing paired wrapper nonces", () => {
    const hashes = ["same", "same", "changed"].map((suffix) => {
      const text = wrapExternalContent(`${"\\".repeat(20_000)}"${suffix}"`, { source: "browser" });
      return outcomeHash(JSON.stringify({ text }));
    });
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("distinguishes malformed empty-ID envelopes from valid zero IDs", () => {
    const valid = wrapExternalContent("same page", { source: "browser" });
    const hashes = [
      valid,
      valid.replace(/id="[a-f0-9]{16}"/g, 'id=""'),
      valid.replace(/id="[a-f0-9]{16}"/g, 'id="0000000000000000"'),
    ].map((text) => outcomeHash(JSON.stringify({ text })));
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[0]).toBe(hashes[2]);
  });

  it("preserves malformed marker quote escaping", () => {
    const hashes = [0, 1].map((index) => {
      const id = index.toString().repeat(16);
      const quote = "\\".repeat(2) + '"';
      return outcomeHash(
        `<<<EXTERNAL_UNTRUSTED_CONTENT id=${quote}${id}${quote}>>>payload<<<END_EXTERNAL_UNTRUSTED_CONTENT id=${quote}${id}${quote}>>>`,
      );
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

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

  it("allows polling when output progresses", () => {
    const loop = createLoop("process", { action: "poll", sessionId: "sess-1" });
    loop.repeat(CRITICAL_THRESHOLD + 5, (index) => ({
      content: [{ type: "text", text: `line ${index}` }],
      details: { status: "running", aggregated: `line ${index}` },
    }));
    expect(loop.detect()).toEqual({ stuck: false });
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

  it("does not treat generic stable successes as semantic no-progress", () => {
    const paths = ["/a", "/b", "/a", "/a", "/b"];
    const loop = createLoop("side_effect", { path: "/a" });
    loop.repeat(
      CRITICAL_THRESHOLD,
      () => jsonResult({ ok: true }),
      (index) => ({ path: paths[index % paths.length] }),
    );
    const result = loop.detect();
    expect(result).toMatchObject({ stuck: true, level: "warning", detector: "generic_repeat" });
    expect(result).not.toHaveProperty("livenessSignal");
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
      status: "completed",
      exitCode: 1,
      output: "Traceback: missing package\n\n(Command exited with code 1)",
    },
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

  it.each([
    { label: "exit code", before: () => "command failed", after: "command failed", exitCode: 2 },
    {
      label: "diagnostic text",
      before: () => "dependency missing",
      after: "syntax error",
      exitCode: 1,
    },
    {
      label: "diagnostic number",
      before: (index: number) => `errno 111 at 12:00:${10 + index}`,
      after: "errno 113 at 12:00:39",
      exitCode: 1,
    },
    {
      label: "calendar date",
      before: () => "certificate becomes valid on 2026-08-30",
      after: "certificate becomes valid on 2026-08-31",
      exitCode: 1,
    },
  ])("resets a terminal-failure streak after a new $label", ({ before, after, exitCode }) => {
    const loop = createLoop("exec", { command: "node retry.js" });
    loop.repeat(CRITICAL_THRESHOLD - 1, (index) =>
      execResult({ status: "completed", exitCode: 1, output: before(index) }),
    );
    loop.record(execResult({ status: "completed", exitCode, output: after }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
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
      label: "exit-code-only output",
      status: "completed",
      exitCode: 1,
      output: "\n\n(Command exited with code 1)",
    },
    { label: "successful batches", status: "completed", exitCode: 0, output: "done" },
    {
      label: "timeouts",
      status: "failed",
      exitCode: 1,
      output: "Command timed out",
      timedOut: true,
    },
    {
      label: "non-finite exit codes",
      status: "failed",
      exitCode: Number.POSITIVE_INFINITY,
      output: "process failed",
    },
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

  it.each(["exec", "read"])(
    "resets the semantic failure tail after a successful %s",
    (toolName) => {
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
    },
  );

  it("blocks completed exec calls despite volatile runtime details", () => {
    const loop = createLoop("exec", { command: "grafana-api.sh datasources" });
    loop.repeat(CRITICAL_THRESHOLD, (index) => ({
      content: [{ type: "text", text: "Loki\nPrometheus" }],
      details: {
        status: "completed",
        exitCode: 0,
        durationMs: 100 + index,
        cwd: `/tmp/run-${index}`,
        aggregated: "Loki\nPrometheus",
      },
    }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
    });
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

  it.each([
    { queries: ["alpha"], hits: true, detector: "generic_repeat" },
    { queries: ["alpha", "beta"], hits: true, detector: "ping_pong" },
    { queries: ["alpha"], hits: false, detector: "generic_repeat" },
  ])("blocks memory-search $detector loops with hits=$hits", ({ queries, hits, detector }) => {
    const loop = createLoop("memory_search", { query: "alpha" });
    loop.repeat(
      CRITICAL_THRESHOLD,
      (index) =>
        jsonResult({
          results: hits
            ? [
                {
                  path: "memory/notes.md",
                  startLine: 1,
                  endLine: 2,
                  score: 0.42 + index * 1e-9,
                  vectorScore: 0.5,
                  snippet: "status: nothing new",
                  source: "memory",
                },
              ]
            : [],
          provider: "none",
          mode: "fts",
          debug: {
            backend: "builtin",
            effectiveMode: "fts",
            hits: hits ? 1 : 0,
            managerMs: 1 + index,
            searchMs: 3 + index,
            toolMs: 5 + index,
            outsideSearchMs: 2 + index,
          },
        }),
      (index) => ({ query: queries[index % queries.length] }),
    );
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector,
    });
  });

  it.each([
    { results: [{ path: "memory/other.md", snippet: "same", startLine: 1, endLine: 2 }] },
    { results: [{ path: "memory/notes.md", snippet: "changed", startLine: 1, endLine: 2 }] },
    { results: [{ path: "memory/notes.md", snippet: "same", startLine: 3, endLine: 4 }] },
    { results: [] },
    { stale: true, warning: "Memory index is stale", action: "Rebuild the index" },
    { partial: true },
    { error: "Search unavailable", disabled: true },
  ])("resets a memory-search streak when semantic content changes: %j", (change) => {
    const loop = createLoop("memory_search", { query: "alpha" });
    const result = jsonResult({
      results: [{ path: "memory/notes.md", snippet: "same", startLine: 1, endLine: 2, score: 0.4 }],
      provider: "none",
      debug: { searchMs: 3 },
    });
    const delivered = structuredClone(result);
    loop.repeat(CRITICAL_THRESHOLD, () => result);
    expect(loop.detect()).toMatchObject({ level: "critical" });
    expect(result).toEqual(delivered);
    loop.record(jsonResult({ ...result.details, ...change }));
    expect(loop.detect()).toMatchObject({ level: "warning" });
  });

  it.each(["error", "unstructured"])("preserves full memory-search %s results", (kind) => {
    const loop = createLoop("memory_search", { query: "alpha" });
    loop.repeat(CRITICAL_THRESHOLD, (index) => ({
      content: [{ type: "text", text: `changed result ${index}` }],
      ...(kind === "error" ? { isError: true, details: { results: [] } } : {}),
    }));
    expect(loop.detect()).toMatchObject({ level: "warning" });
  });

  it.each([
    [
      "ordered hits",
      (index: number) => ({
        results:
          index % 2 === 0
            ? [
                { path: "memory/a.md", snippet: "a" },
                { path: "memory/b.md", snippet: "b" },
              ]
            : [
                { path: "memory/b.md", snippet: "b" },
                { path: "memory/a.md", snippet: "a" },
              ],
        debug: { backend: "builtin" },
      }),
    ],
    [
      "stable debug state",
      (index: number) => ({
        results: [{ path: "memory/a.md", snippet: "a" }],
        debug: { backend: index % 2 === 0 ? "builtin" : "sqlite" },
      }),
    ],
  ] as const)("does not critically block progressing memory-search %s", (_label, details) => {
    const loop = createLoop("memory_search", { query: "alpha" });
    loop.repeat(CRITICAL_THRESHOLD, (index) => ({
      content: [{ type: "text", text: "ignored structured rendering" }],
      details: details(index),
    }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
    });
  });

  it("blocks changing-argument unknown-tool retries only at the threshold", () => {
    const loop = createLoop("exec", { command: "echo next" });
    for (let index = 0; index < UNKNOWN_TOOL_THRESHOLD - 1; index++) {
      loop.fail(new Error("Tool exec not found"), { command: `echo ${index}` });
    }
    expect(loop.detect()).toEqual({ stuck: false });
    loop.fail(new Error("Tool exec not found"), { command: "echo last" });
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "unknown_tool_repeat",
      count: UNKNOWN_TOOL_THRESHOLD,
    });
  });

  it.each(["Unknown tool: missing_a", "Unknown tool id: missing_a"])(
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

  it.each([
    { outcome: "missing", count: WARNING_THRESHOLD - 1, level: "warning" },
    { outcome: "stable", count: CRITICAL_THRESHOLD - 1, level: "critical" },
    { outcome: "progressing", count: CRITICAL_THRESHOLD - 1, level: "warning" },
  ])("detects ping-pong with $outcome outcomes", ({ outcome, count, level }) => {
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
  });

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

  it("attaches outcomes to pending calls while trimming the history window", () => {
    const loop = createLoop("gateway", {});
    let lastRecordedToolCallId: string | undefined;
    for (let index = 0; index < HISTORY_SIZE + 3; index++) {
      lastRecordedToolCallId = loop.record(
        { content: [{ type: "text", text: `schema-${index}` }] },
        { action: "lookup", path: `config.${index}` },
      )?.toolCallId;
    }
    expect(lastRecordedToolCallId).toBe(`gateway-${HISTORY_SIZE + 2}`);
    expect(loop.state.toolCallHistory).toHaveLength(HISTORY_SIZE);
    expect(loop.state.toolCallHistory?.[0]?.toolCallId).toBe("gateway-3");
    expect(loop.state.toolCallHistory?.[0]?.resultHash).toBeTypeOf("string");
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

  it.each([
    ["sessions_send", { sessionKey: "agent:main:peer", text: "ping" }],
    ["telegram", { to: "telegram:123", text: "ping" }],
  ] as const)("blocks %s loops despite fresh delivery IDs", (toolName, params) => {
    const loop = createLoop(toolName, params);
    loop.repeat(CRITICAL_THRESHOLD, (index) => jsonResult(sendPayload(index)));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
    });
  });

  it("preserves ID and timestamp progress for non-send message actions", () => {
    const loop = createLoop("message", { action: "read", target: "feishu:oc_chat" });
    const first = loop.record(jsonResult({ ok: true, messageId: "m_0", ts: 1000 }))?.resultHash;
    const second = loop.record(jsonResult({ ok: true, messageId: "m_1", ts: 2000 }))?.resultHash;
    expect(first).toBeTypeOf("string");
    expect(first).not.toBe(second);
  });

  it("counts loop vetoes until the global circuit breaker becomes reachable", () => {
    const loop = createSendLoop();
    for (let index = CRITICAL_THRESHOLD; index < HISTORY_SIZE; index++) {
      expect(loop.detect()).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "generic_repeat",
        count: index,
      });
      expect(
        recordToolCallOutcome(loop.state, {
          toolName: "message",
          toolParams: sendParams,
          toolCallId: `message-veto-${index}`,
          result: veto,
        }),
      ).toMatchObject({
        toolCallId: `message-veto-${index}`,
        outcomeKind: "tool-loop-veto",
        resultHash: undefined,
      });
    }
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: HISTORY_SIZE,
    });
  });

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

  it("still escalates repeated plugin vetoes to a critical loop", () => {
    const loop = createLoop("message", { action: "read", target: "feishu:oc_chat" });
    loop.repeat(CRITICAL_THRESHOLD, () => ({
      ...veto,
      details: { status: "blocked", deniedReason: "plugin-before-tool-call" },
    }));
    expect(loop.detect()).toMatchObject({
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
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
