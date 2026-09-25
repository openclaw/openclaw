// Live Plugin Tool Assertions tests cover live plugin tool assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createNestedToolActivity } from "../../src/sessions/nested-tool-activity.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/live-plugin-tool/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function deferredToolTranscript() {
  const toolCall = {
    type: "toolCall",
    id: "outer-call",
    name: "tool_call",
    arguments: { id: "e2e_slug_probe" },
  };
  const call = {
    role: "assistant",
    content: [toolCall] satisfies [typeof toolCall],
  };
  const nested = createNestedToolActivity({
    runId: "live-run",
    scopeId: "live-scope",
    afterEntryId: "assistant-entry",
    startOrder: 0,
    parentToolCallId: "outer-call",
    toolCallId: "nested-call",
    toolName: "e2e_slug_probe",
    input: {},
    result: { content: [{ type: "text", text: "live-plugin-slug" }] },
    isError: false,
    startedAt: 100,
    timestamp: 101,
  });
  const result = {
    role: "toolResult",
    toolCallId: "outer-call",
    toolName: "tool_call",
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({ tool: { name: "e2e_slug_probe" }, result: nested.details.result }),
      },
    ],
  };
  return { call, nested, result };
}

function runTranscriptAssertion(
  messages: unknown[],
  { format = "sqlite", sessionId = "live-plugin-tool" } = {},
) {
  const root = tempDirs.make("openclaw-live-plugin-tool-");
  writeJson(path.join(root, "agent.json"), { payloads: [{ text: "live-plugin-slug" }] });
  if (format === "jsonl") {
    const file = path.join(root, "state", "agents", "main", "sessions", "session.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, messages.map((message) => JSON.stringify({ message })).join("\n"));
  } else {
    const file = path.join(root, "state", "agents", "main", "agent", "openclaw-agent.sqlite");
    mkdirSync(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    try {
      const compressed = format === "sqlite-zstd";
      database.exec(`CREATE TABLE transcript_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        event_json TEXT ${compressed ? ", event_zstd BLOB, event_utf8_bytes INTEGER" : "NOT NULL"}
      )`);
      const insert = database.prepare(
        compressed
          ? "INSERT INTO transcript_events (session_id, seq, event_json, event_zstd, event_utf8_bytes) VALUES (?, ?, NULL, ?, ?)"
          : "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
      );
      messages.forEach((message, index) => {
        const payload = JSON.stringify({ message });
        if (compressed) {
          const bytes = Buffer.from(payload);
          insert.run(sessionId, index, zstdCompressSync(bytes), bytes.length);
        } else {
          insert.run(sessionId, index, payload);
        }
      });
    } finally {
      database.close();
    }
  }
  return runAssertion(root);
}

function nodeOptionsWithoutExperimentalWarnings(extra?: string): string {
  const current = [process.env.NODE_OPTIONS, extra].filter(Boolean).join(" ");
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(root: string, env: Record<string, string> = {}) {
  return runAssertionCommand("assert-agent-turn", root, env);
}

function runAssertionCommand(command: string, root: string, env: Record<string, string> = {}) {
  return spawnSync(testNodeExecPath, [ASSERTIONS_SCRIPT, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SLUG: "live-plugin-slug",
      HOME: root,
      MODEL_REF: "openai/gpt-5.5",
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_ERROR_PATH: path.join(root, "agent.err"),
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_PATH: path.join(root, "agent.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      PLUGIN_ID: "e2e-live-plugin-tool",
      PLUGIN_NAME: "@openclaw/e2e-live-plugin-tool",
      PLUGIN_VERSION: "1.0.0",
      SEED: "live plugin slug",
      TOOL_NAME: "e2e_slug_probe",
      ...env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(env.NODE_OPTIONS),
    },
  });
}

describe("live plugin tool assertions", () => {
  it.each([
    {
      format: "sqlite-zstd",
      selector: { id: "e2e_slug_probe", name: "record-name" },
      input: { name: "record-name" },
      wire: "native",
    },
    {
      format: "jsonl",
      selector: { id: "openclaw:e2e-live-plugin-tool:e2e_slug_probe" },
      wire: "native",
    },
    { format: "sqlite", selector: { name: "e2e_slug_probe" }, wire: "native" },
    { format: "sqlite", selector: { input: { toolId: "e2e_slug_probe" } }, wire: "native" },
    {
      format: "sqlite",
      selector: { id: "openclaw:e2e-live-plugin-tool:e2e_slug_probe" },
      wire: "function",
    },
  ])(
    "reads accepted nested tool activity from $format: $wire $selector",
    ({ format, selector, wire, input }) => {
      const { call, nested, result } = deferredToolTranscript();
      nested.details.input = input ?? {};
      const dispatcher =
        wire === "function"
          ? {
              role: "assistant",
              tool_calls: [
                {
                  id: "outer-call",
                  type: "function",
                  function: { name: "tool_call", arguments: JSON.stringify(selector) },
                },
              ],
            }
          : { ...call, content: [{ ...call.content[0], arguments: selector }] };
      const assertion = runTranscriptAssertion([dispatcher, nested, result], { format });
      expect(assertion.status, assertion.stderr).toBe(0);
      expect(assertion.stderr).toBe("");
    },
  );

  it.each([
    "another target",
    "failed receipt",
    "failure text",
    "marker only in input",
    "wrong parent",
    "unrelated dispatcher parent",
    "another plugin selector",
    "missing target selector",
    "unrelated outer selector",
    "malformed dispatcher arguments",
    "missing parent",
    "missing nested call id",
    "missing success flag",
    "unrecognized receipt",
    "user-authored call",
    "receipt before call",
    "no dispatcher call",
    "outer result only",
    "another session",
  ])("rejects deferred tool evidence with %s", (scenario) => {
    const { call, nested, result } = deferredToolTranscript();
    let messages: unknown[] = [call, nested, result];
    switch (scenario) {
      case "another target":
        nested.details.toolName = "unrelated_tool";
        break;
      case "failed receipt":
        nested.details.isError = true;
        break;
      case "failure text":
        nested.details.result.content = [{ type: "text", text: "Error: live-plugin-slug" }];
        break;
      case "marker only in input":
        nested.details.input = { marker: "live-plugin-slug" };
        nested.details.result.content = [{ type: "text", text: "no output" }];
        break;
      case "wrong parent":
        nested.details.parentToolCallId = "another-call";
        break;
      case "unrelated dispatcher parent": {
        const unrelatedCall = structuredClone(call);
        unrelatedCall.content[0].id = "unrelated-parent";
        unrelatedCall.content[0].arguments.id = "unrelated_tool";
        nested.details.parentToolCallId = "unrelated-parent";
        messages = [unrelatedCall, call, nested, result];
        break;
      }
      case "another plugin selector":
        call.content[0].arguments.id = "openclaw:unrelated-plugin:e2e_slug_probe";
        break;
      case "missing target selector":
        call.content[0].arguments.id = "";
        break;
      case "unrelated outer selector":
        messages = [
          {
            ...call,
            content: [
              {
                ...call.content[0],
                arguments: { id: "unrelated_tool", input: { id: "e2e_slug_probe" } },
              },
            ],
          },
          nested,
          result,
        ];
        break;
      case "malformed dispatcher arguments":
        messages = [{ ...call, content: [{ ...call.content[0], arguments: "{" }] }, nested, result];
        break;
      case "missing parent":
        delete nested.details.parentToolCallId;
        break;
      case "missing nested call id":
        nested.details.toolCallId = "";
        break;
      case "missing success flag":
        messages = [
          call,
          { ...nested, details: { ...nested.details, isError: undefined } },
          result,
        ];
        break;
      case "unrecognized receipt":
        messages = [call, { ...nested, customType: "unrelated.v1" }, result];
        break;
      case "user-authored call":
        call.role = "user";
        break;
      case "receipt before call":
        messages = [nested, call, result];
        break;
      case "no dispatcher call":
        messages = [nested, result];
        break;
      case "outer result only":
        messages = [call, result];
        break;
    }
    const assertion = runTranscriptAssertion(messages, {
      sessionId: scenario === "another session" ? "other-session" : "live-plugin-tool",
    });
    expect(assertion.status).not.toBe(0);
    expect(assertion.stderr).toContain("missing causal tool-result evidence");
  });

  it("rejects loose timeout env values instead of parsing numeric prefixes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    try {
      const result = runAssertionCommand("configure", root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: "1e3",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: 1e3");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes strict positive timeout values into generated config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    try {
      const result = runAssertionCommand("configure", root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: "240",
      });

      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(readFileSync(path.join(root, "state", "openclaw.json"), "utf8"));
      expect(config.models.providers.openai.timeoutSeconds).toBe(240);
      expect(config.agents.defaults.timeoutSeconds).toBe(240);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("streams session transcripts across chunk boundaries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        [
          JSON.stringify({
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-live-plugin-tool",
                  name: "e2e_slug_probe",
                  input: { seed: "live plugin slug" },
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "tool",
              tool_call_id: "call-live-plugin-tool",
              content: `${"x".repeat(64 * 1024)}\nlive-plugin-slug`,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads Code Mode exec evidence from the canonical SQLite transcript", () => {
    const result = runTranscriptAssertion([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-live-plugin-tool", name: "exec" }],
      },
      {
        role: "tool",
        tool_call_id: "call-live-plugin-tool",
        content: "Code cell still running: cell-live-plugin-tool",
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "wait-live-plugin-tool", name: "wait" }],
      },
      {
        role: "tool",
        tool_call_id: "wait-live-plugin-tool",
        content: "live-plugin-slug",
      },
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects markers that only appear as raw transcript text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing causal tool-result evidence");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects split transcript evidence across unrelated files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      const { call, nested, result: outerResult } = deferredToolTranscript();
      writeFileSync(path.join(sessionsDir, "tool.jsonl"), JSON.stringify({ message: call }));
      writeFileSync(
        path.join(sessionsDir, "reply.jsonl"),
        [nested, outerResult].map((message) => JSON.stringify({ message })).join("\n"),
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript did not show");
      expect(result.stderr).toContain("0 SQLite event(s) and 2 jsonl file(s)");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds session transcript traversal before scanning unbounded trees", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      for (let index = 0; index < 4; index += 1) {
        writeFileSync(path.join(sessionsDir, `noise-${index}.jsonl`), "noise\n", "utf8");
      }

      const result = runAssertion(root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES: "2",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript scan exceeded 2 filesystem entries");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects markers that only appear in error payload text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [
          { isError: true, text: "live-plugin-slug" },
          { text: "regular reply without the expected marker" },
        ],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live agent reply did not contain tool slug");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non-JSON stdout even when a later object contains the slug", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeFileSync(
        path.join(root, "agent.json"),
        ["warning before json", JSON.stringify({ payloads: [{ text: "live-plugin-slug" }] })].join(
          "\n",
        ),
        "utf8",
      );
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        ["e2e_slug_probe", "live-plugin-slug"].join("\n"),
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected token");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds agent output diagnostics on missing reply slug", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [
          {
            text: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(70 * 1024)}\nrecent stdout tail`,
          },
        ],
      });
      writeFileSync(
        path.join(root, "agent.err"),
        `DO_NOT_DUMP_OLD_STDERR${"x".repeat(70 * 1024)}\nrecent stderr tail\n`,
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("stdout tail=");
      expect(result.stderr).toContain("stderr tail=");
      expect(result.stderr).toContain("recent stdout tail");
      expect(result.stderr).toContain("recent stderr tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDOUT");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDERR");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects oversized agent output before parsing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));

    try {
      writeFileSync(
        path.join(root, "agent.json"),
        `DO_NOT_DUMP_OLD_AGENT_OUTPUT${"x".repeat(70 * 1024)}\nrecent oversized stdout tail`,
        "utf8",
      );
      writeFileSync(path.join(root, "agent.err"), "recent stderr tail\n", "utf8");

      const result = runAssertion(root, {
        OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES: "1024",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live agent output exceeded 1024 bytes");
      expect(result.stderr).toContain("recent oversized stdout tail");
      expect(result.stderr).toContain("recent stderr tail");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AGENT_OUTPUT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not dump session transcript contents when a transcript check fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-plugin-tool-"));
    const sessionsDir = path.join(root, "state", "agents", "main", "sessions");

    try {
      writeJson(path.join(root, "agent.json"), {
        payloads: [{ text: "live-plugin-slug" }],
      });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "session.jsonl"),
        `DO_NOT_DUMP_SESSION_CONTENT${"x".repeat(70 * 1024)}\n`,
        "utf8",
      );

      const result = runAssertion(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("session transcript did not show");
      expect(result.stderr).toContain("0 SQLite event(s) and 1 jsonl file(s)");
      expect(result.stderr).toContain("session.jsonl");
      expect(result.stderr).not.toContain("DO_NOT_DUMP_SESSION_CONTENT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
