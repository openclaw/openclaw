import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createNestedToolActivity } from "../../src/sessions/nested-tool-activity.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/live-plugin-tool/assertions.mjs";
const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const slug = "live-plugin-slug";
const toolName = "e2e_slug_probe";
const textContent = (text: string) => [{ type: "text", text }];

function toolCall(id: string, name: string, type = "tool_use", args?: { id: string }) {
  const call = { type, id, name, arguments: args };
  return { role: "assistant", content: [call] satisfies [typeof call] };
}

function toolResult(tool_call_id: string, content: string) {
  return { role: "tool", tool_call_id, content };
}

function deferredToolTranscript() {
  const call = toolCall("outer-call", "dispatch_action", "toolCall", { id: toolName });
  const nested = createNestedToolActivity({
    runId: "live-run",
    scopeId: "live-scope",
    afterEntryId: "assistant-entry",
    startOrder: 0,
    parentToolCallId: "outer-call",
    toolCallId: "nested-call",
    toolName,
    input: {},
    result: { content: textContent(slug) },
    isError: false,
    startedAt: 100,
    timestamp: 101,
  });
  const result = {
    role: "toolResult",
    toolCallId: "outer-call",
    toolName: "dispatch_action",
    isError: false,
    content: textContent(
      JSON.stringify({ tool: { name: toolName }, result: nested.details.result }),
    ),
  };
  return { call, nested, result };
}

function runTranscriptAssertion(messages: unknown[], { format = "sqlite" } = {}) {
  const root = makeTranscriptRoot();
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

function makeTranscriptRoot(files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-live-plugin-tool-");
  const sessionsDir = path.join(root, "state", "agents", "main", "sessions");
  writeFileSync(path.join(root, "agent.json"), JSON.stringify({ payloads: [{ text: slug }] }));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(path.join(sessionsDir, name), contents, "utf8");
  }
  return root;
}

function expectFailure(result: ReturnType<typeof runAssertion>, ...messages: string[]) {
  expect(result.status).not.toBe(0);
  for (const message of messages) {
    expect(result.stderr).toContain(message);
  }
}

function runAssertion(root: string, env: NodeJS.ProcessEnv = {}, command = "assert-agent-turn") {
  const args = ["--disable-warning=ExperimentalWarning", ASSERTIONS_SCRIPT, command];
  return spawnSync(testNodeExecPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SLUG: slug,
      HOME: root,
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_ERROR_PATH: path.join(root, "agent.err"),
      OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_PATH: path.join(root, "agent.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      PLUGIN_ID: "e2e-live-plugin-tool",
      TOOL_NAME: toolName,
      ...env,
    },
  });
}

it("reads accepted nested tool activity from compressed SQLite with target name arguments", () => {
  const { call, nested, result } = deferredToolTranscript();
  nested.details.input = { name: "record-name" };
  const dispatcher = {
    ...call,
    content: [{ ...call.content[0], arguments: { id: toolName, name: "record-name" } }],
  };
  const assertion = runTranscriptAssertion([dispatcher, nested, result], {
    format: "sqlite-zstd",
  });
  expect(assertion).toMatchObject({ status: 0, stderr: "" });
});

it.each(["unrelated dispatcher parent", "receipt before call"])(
  "rejects deferred tool evidence with %s",
  (scenario) => {
    const { call, nested, result } = deferredToolTranscript();
    let messages: unknown[];
    if (scenario === "unrelated dispatcher parent") {
      const unrelatedCall = toolCall("unrelated-parent", "dispatch_action", "toolCall", {
        id: "unrelated_tool",
      });
      nested.details.parentToolCallId = "unrelated-parent";
      messages = [unrelatedCall, call, nested, result];
    } else {
      messages = [nested, call, result];
    }
    const assertion = runTranscriptAssertion(messages);
    expectFailure(assertion, "missing causal tool-result evidence");
  },
);

it("rejects loose timeout env values instead of parsing numeric prefixes", () => {
  const root = tempDirs.make("openclaw-live-plugin-tool-");
  const result = runAssertion(
    root,
    {
      OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: "1e3",
    },
    "configure",
  );

  expectFailure(result, "invalid OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS: 1e3");
});

it("reads Code Mode exec evidence from the canonical SQLite transcript", () => {
  const result = runTranscriptAssertion([
    toolCall("call-live-plugin-tool", "exec"),
    toolResult("call-live-plugin-tool", "Code cell still running: cell-live-plugin-tool"),
    toolCall("wait-live-plugin-tool", "wait"),
    toolResult("wait-live-plugin-tool", slug),
  ]);

  expect(result).toMatchObject({ status: 0, stderr: "" });
});

it("rejects markers that only appear as raw transcript text", () => {
  const root = makeTranscriptRoot({ "session.jsonl": "e2e_slug_probe\nlive-plugin-slug" });
  expectFailure(runAssertion(root), "missing causal tool-result evidence");
});

it("rejects split transcript evidence across unrelated files", () => {
  const { call, nested, result: outerResult } = deferredToolTranscript();
  const root = makeTranscriptRoot({
    "tool.jsonl": JSON.stringify({ message: call }),
    "reply.jsonl": [nested, outerResult].map((message) => JSON.stringify({ message })).join("\n"),
  });
  expectFailure(
    runAssertion(root),
    "session transcript did not show",
    "0 SQLite event(s) and 2 jsonl file(s)",
  );
});

it("bounds session transcript traversal before scanning unbounded trees", () => {
  const root = makeTranscriptRoot(
    Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [`noise-${index}.jsonl`, "noise\n"]),
    ),
  );

  const result = runAssertion(root, {
    OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES: "2",
  });

  expectFailure(result, "session transcript scan exceeded 2 filesystem entries");
});

it("rejects oversized agent output before parsing it", () => {
  const root = tempDirs.make("openclaw-live-plugin-tool-");
  writeFileSync(
    path.join(root, "agent.json"),
    `DO_NOT_DUMP_OLD_AGENT_OUTPUT${"x".repeat(70 * 1024)}\nrecent oversized stdout tail`,
    "utf8",
  );
  writeFileSync(path.join(root, "agent.err"), "recent stderr tail\n", "utf8");

  const result = runAssertion(root, {
    OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES: "1024",
  });

  expectFailure(
    result,
    "live agent output exceeded 1024 bytes",
    "recent oversized stdout tail",
    "recent stderr tail",
  );
  expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AGENT_OUTPUT");
});

it("does not dump session transcript contents when a transcript check fails", () => {
  const root = makeTranscriptRoot({
    "session.jsonl": `DO_NOT_DUMP_SESSION_CONTENT${"x".repeat(70 * 1024)}\n`,
  });

  const result = runAssertion(root);

  expectFailure(
    result,
    "session transcript did not show",
    "0 SQLite event(s) and 1 jsonl file(s)",
    "session.jsonl",
  );
  expect(result.stderr).not.toContain("DO_NOT_DUMP_SESSION_CONTENT");
});
