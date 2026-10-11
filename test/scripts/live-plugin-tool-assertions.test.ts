// Live Plugin Tool Assertions tests cover live plugin tool assertions script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runTranscriptAssertion(messages: unknown[], { format = "sqlite" } = {}) {
  const root = tempDirs.make("openclaw-live-plugin-tool-");
  writeJson(path.join(root, "agent.json"), { payloads: [{ text: "live-plugin-slug" }] });
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
        insert.run("live-plugin-tool", index, zstdCompressSync(bytes), bytes.length);
      } else {
        insert.run("live-plugin-tool", index, payload);
      }
    });
  } finally {
    database.close();
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
  it("reads accepted nested tool activity from compressed SQLite with target name arguments", () => {
    const { call, nested, result } = deferredToolTranscript();
    nested.details.input = { name: "record-name" };
    const dispatcher = {
      ...call,
      content: [{ ...call.content[0], arguments: { id: "e2e_slug_probe", name: "record-name" } }],
    };
    const assertion = runTranscriptAssertion([dispatcher, nested, result], {
      format: "sqlite-zstd",
    });
    expect(assertion.status, assertion.stderr).toBe(0);
    expect(assertion.stderr).toBe("");
  });

  it.each(["unrelated dispatcher parent", "receipt before call"])(
    "rejects deferred tool evidence with %s",
    (scenario) => {
      const { call, nested, result } = deferredToolTranscript();
      let messages: unknown[];
      if (scenario === "unrelated dispatcher parent") {
        const unrelatedCall = structuredClone(call);
        unrelatedCall.content[0].id = "unrelated-parent";
        unrelatedCall.content[0].arguments.id = "unrelated_tool";
        nested.details.parentToolCallId = "unrelated-parent";
        messages = [unrelatedCall, call, nested, result];
      } else {
        messages = [nested, call, result];
      }
      const assertion = runTranscriptAssertion(messages);
      expect(assertion.status).not.toBe(0);
      expect(assertion.stderr).toContain("missing causal tool-result evidence");
    },
  );

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
