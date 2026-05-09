import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportSqliteSessionTranscriptJsonl,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  BLANK_USER_FALLBACK_TEXT,
  repairTranscriptSessionStateIfNeeded,
} from "./transcript-state-repair.js";

function buildSessionHeaderAndMessage() {
  const header = {
    type: "session",
    version: 7,
    id: "session-1",
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
  const message = {
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello" },
  };
  return { header, message };
}

const tempDirs: string[] = [];
const TEST_SCOPE = { agentId: "main", sessionId: "session-1" } as const;

async function createTempTranscriptScope() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-repair-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return {
    dir,
    scope: TEST_SCOPE,
  };
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function writeTranscriptEvents(scope: typeof TEST_SCOPE, events: unknown[]) {
  const sessionId =
    events.find((event): event is { type: "session"; id: string } =>
      Boolean(
        event &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "session" &&
        typeof (event as { id?: unknown }).id === "string",
      ),
    )?.id ?? "session-1";
  replaceSqliteSessionTranscriptEvents({
    agentId: scope.agentId,
    sessionId,
    events,
  });
}

async function readTranscriptJsonl(scope: typeof TEST_SCOPE): Promise<string> {
  return exportSqliteSessionTranscriptJsonl(scope);
}

describe("repairTranscriptSessionStateIfNeeded", () => {
  it("rewrites SQLite transcripts that contain malformed messages", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();

    writeTranscriptEvents(scope, [
      header,
      message,
      { type: "message", id: "corrupt", message: { role: null, content: "bad" } },
    ]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);

    const repaired = await readTranscriptJsonl(scope);
    expect(repaired.trim().split("\n")).toHaveLength(2);
  });

  it("warns and skips repair when the session header is invalid", async () => {
    const { scope } = await createTempTranscriptScope();
    const badHeader = {
      type: "message",
      id: "msg-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    };
    writeTranscriptEvents(scope, [badHeader]);

    const warn = vi.fn();
    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      warn,
    });

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("invalid session header");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid session header");
  });

  it("rewrites persisted assistant messages with empty content arrays", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "transient stream failure",
      },
    };
    // Follow-up keeps this case focused on empty error-turn repair.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "retry" },
    };
    writeTranscriptEvents(scope, [header, message, poisonedAssistantEntry, followUp]);

    const debug = vi.fn();
    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      debug,
    });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(0);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(debug).toHaveBeenCalledTimes(1);
    const debugMessage = debug.mock.calls[0]?.[0] as string;
    expect(debugMessage).toContain("rewrote 1 assistant message(s)");
    expect(debugMessage).not.toContain("dropped");

    const repaired = await readTranscriptJsonl(scope);
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(4);
    const repairedEntry: { message: { content: { type: string; text: string }[] } } = JSON.parse(
      repairedLines[2],
    );
    expect(repairedEntry.message.content).toEqual([
      { type: "text", text: "[assistant turn failed before producing content]" },
    ]);
  });

  it("rewrites blank-only user text messages to synthetic placeholder instead of dropping", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const blankUserEntry = {
      type: "message",
      id: "msg-blank",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    };
    writeTranscriptEvents(scope, [header, blankUserEntry, message]);

    const debug = vi.fn();
    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      debug,
    });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);
    expect(result.droppedBlankUserMessages).toBe(0);
    expect(debug.mock.calls[0]?.[0]).toContain("rewrote 1 user message(s)");

    const repaired = await readTranscriptJsonl(scope);
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(3);
    const rewrittenEntry = JSON.parse(repairedLines[1]);
    expect(rewrittenEntry.id).toBe("msg-blank");
    expect(rewrittenEntry.message.content).toEqual([
      { type: "text", text: BLANK_USER_FALLBACK_TEXT },
    ]);
  });

  it("rewrites blank string-content user messages to placeholder", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const blankStringUserEntry = {
      type: "message",
      id: "msg-blank-str",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: "   ",
      },
    };
    writeTranscriptEvents(scope, [header, blankStringUserEntry, message]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);

    const repaired = await readTranscriptJsonl(scope);
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(3);
    const rewrittenEntry = JSON.parse(repairedLines[1]);
    expect(rewrittenEntry.message.content).toBe(BLANK_USER_FALLBACK_TEXT);
  });

  it("removes blank user text blocks while preserving media blocks", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header } = buildSessionHeaderAndMessage();
    const mediaUserEntry = {
      type: "message",
      id: "msg-media",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "   " },
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      },
    };
    writeTranscriptEvents(scope, [header, mediaUserEntry]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);
    const repaired = await readTranscriptJsonl(scope);
    const repairedEntry = JSON.parse(repaired.trim().split("\n")[1] ?? "{}");
    expect(repairedEntry.message.content).toEqual([
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
  });

  it("reports both drops and rewrites in the debug message when both occur", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    writeTranscriptEvents(scope, [
      header,
      poisonedAssistantEntry,
      { type: "message", id: "corrupt", message: { role: null, content: "bad" } },
    ]);

    const debug = vi.fn();
    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      debug,
    });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.rewrittenAssistantMessages).toBe(1);
    const debugMessage = debug.mock.calls[0]?.[0] as string;
    expect(debugMessage).toContain("dropped 1 malformed line(s)");
    expect(debugMessage).toContain("rewrote 1 assistant message(s)");
  });

  it("does not rewrite silent-reply turns (stopReason=stop, content=[])", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header } = buildSessionHeaderAndMessage();
    const silentReplyEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "ollama",
        model: "glm-5.1:cloud",
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
        stopReason: "stop",
      },
    };
    // Follow-up keeps this case focused on silent-reply preservation.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    writeTranscriptEvents(scope, [header, silentReplyEntry, followUp]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const original = `${JSON.stringify(header)}\n${JSON.stringify(silentReplyEntry)}\n${JSON.stringify(followUp)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("preserves delivered trailing assistant messages", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale answer" }],
        stopReason: "stop",
      },
    };
    writeTranscriptEvents(scope, [header, message, assistantEntry]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);

    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("preserves multiple consecutive delivered trailing assistant messages", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry1 = {
      type: "message",
      id: "msg-asst-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        stopReason: "stop",
      },
    };
    const assistantEntry2 = {
      type: "message",
      id: "msg-asst-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        stopReason: "stop",
      },
    };
    writeTranscriptEvents(scope, [header, message, assistantEntry1, assistantEntry2]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);

    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry1)}\n${JSON.stringify(assistantEntry2)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("does not trim non-trailing assistant messages", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason: "stop",
      },
    };
    const userFollowUp = {
      type: "message",
      id: "msg-user-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    writeTranscriptEvents(scope, [header, message, assistantEntry, userFollowUp]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);
  });

  it("preserves trailing assistant messages that contain tool calls", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that." },
          { type: "toolCall", id: "call_1", name: "read", input: { path: "/tmp/test" } },
        ],
        stopReason: "toolUse",
      },
    };
    writeTranscriptEvents(scope, [header, message, toolCallAssistant]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("preserves adjacent trailing tool-call and text assistant messages", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "read" }],
        stopReason: "toolUse",
      },
    };
    const plainAssistant = {
      type: "message",
      id: "msg-asst-plain",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        stopReason: "stop",
      },
    };
    writeTranscriptEvents(scope, [header, message, toolCallAssistant, plainAssistant]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);

    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(plainAssistant)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("preserves final text assistant turn that follows a tool-call/tool-result pair", async () => {
    // Regression: a trailing assistant message with stopReason "stop" that follows a
    // tool-call turn and its matching tool-result must never be trimmed by the repair
    // pass. This is the exact sequence produced by any agent run that calls at least
    // one tool before returning a final text response, and it must survive intact so
    // subsequent user messages are parented to the correct leaf node.
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();
    const toolCallAssistant = {
      type: "message",
      id: "msg-asst-tc",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "get_tasks", input: {} }],
        stopReason: "toolUse",
      },
    };
    const toolResult = {
      type: "message",
      id: "msg-tool-result",
      parentId: "msg-asst-tc",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "get_tasks",
        content: [{ type: "text", text: "Task A, Task B" }],
        isError: false,
      },
    };
    const finalAssistant = {
      type: "message",
      id: "msg-asst-final",
      parentId: "msg-tool-result",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here are your tasks: Task A, Task B." }],
        stopReason: "stop",
      },
    };
    writeTranscriptEvents(scope, [header, message, toolCallAssistant, toolResult, finalAssistant]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);

    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(toolCallAssistant)}\n${JSON.stringify(toolResult)}\n${JSON.stringify(finalAssistant)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("preserves assistant-only session history after the header", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-asst",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "orphan" }],
        stopReason: "stop",
      },
    };
    writeTranscriptEvents(scope, [header, assistantEntry]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);

    const original = `${JSON.stringify(header)}\n${JSON.stringify(assistantEntry)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("is a no-op on a session that was already repaired", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header } = buildSessionHeaderAndMessage();
    const healedEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    // Follow-up keeps this case focused on idempotent empty error-turn repair.
    const followUp = {
      type: "message",
      id: "msg-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "follow up" },
    };
    writeTranscriptEvents(scope, [header, healedEntry, followUp]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const original = `${JSON.stringify(header)}\n${JSON.stringify(healedEntry)}\n${JSON.stringify(followUp)}\n`;
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(original);
  });

  it("drops type:message entries with null role instead of preserving them through repair (#77228)", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();

    const nullRoleEntry = {
      type: "message",
      id: "corrupt-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: null, content: "ignored" },
    };
    const missingRoleEntry = {
      type: "message",
      id: "corrupt-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { content: "no role at all" },
    };
    const emptyRoleEntry = {
      type: "message",
      id: "corrupt-3",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "   ", content: "blank role" },
    };

    writeTranscriptEvents(scope, [
      header,
      message,
      nullRoleEntry,
      missingRoleEntry,
      emptyRoleEntry,
    ]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(3);

    const after = await readTranscriptJsonl(scope);
    const lines = after.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(header);
    expect(JSON.parse(lines[1])).toEqual(message);
    expect(after).not.toContain('"role":null');
  });

  it("drops a type:message entry whose message field is missing or non-object", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();

    const missingMessage = {
      type: "message",
      id: "corrupt-4",
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    const stringMessage = {
      type: "message",
      id: "corrupt-5",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: "not an object",
    };

    writeTranscriptEvents(scope, [header, message, missingMessage, stringMessage]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(2);

    const after = await readTranscriptJsonl(scope);
    const lines = after.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("preserves non-`message` envelope types (e.g. compactionSummary, custom) without role inspection", async () => {
    const { scope } = await createTempTranscriptScope();
    const { header, message } = buildSessionHeaderAndMessage();

    const summary = {
      type: "summary",
      id: "summary-1",
      timestamp: new Date().toISOString(),
      summary: "opaque summary blob",
    };
    const custom = {
      type: "custom",
      id: "custom-1",
      customType: "model-snapshot",
      timestamp: new Date().toISOString(),
      data: { provider: "openai", modelApi: "openai-responses", modelId: "gpt-5" },
    };

    writeTranscriptEvents(scope, [header, message, summary, custom]);

    const result = await repairTranscriptSessionStateIfNeeded({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
    });

    expect(result.repaired).toBe(false);
    expect(result.droppedLines).toBe(0);
    const content = [
      JSON.stringify(header),
      JSON.stringify(message),
      JSON.stringify(summary),
      JSON.stringify(custom),
    ].join("\n");
    const after = await readTranscriptJsonl(scope);
    expect(after).toBe(`${content}\n`);
  });
});
