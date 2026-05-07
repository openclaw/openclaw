import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";

/**
 * Regression coverage for the "double reply" bug:
 * https://github.com/openclaw/openclaw/issues (root cause described in
 * murmur-ops/notes/double-reply-bug-2026-05-07.md and the corresponding fix
 * brief).
 *
 * Symptom: when a turn ends with `assistant{toolCall} -> toolResult ->
 * assistant{text}` and an inbound user message arrives shortly after (or the
 * trailing assistant text has not yet landed on disk via a non-canonical
 * write path), the user message was historically appended with
 * `parentId = <toolResult.id>` instead of the most-recent conversational
 * (assistant/user) message. On the next normalisation pass the assistant text
 * branch is dropped and the model re-emits the same content, producing a
 * duplicated reply to the user.
 */
describe("appendSessionTranscriptMessage parentId resolution", () => {
  const fixture = useTempSessionsFixture("transcript-append-parent-test-");

  function transcriptPath(): string {
    return path.join(fixture.sessionsDir(), "session.jsonl");
  }

  function writeHeader(): string {
    const file = transcriptPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "session",
        version: 1,
        id: "test-session",
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }) + "\n",
      "utf-8",
    );
    return file;
  }

  function appendRaw(file: string, entry: Record<string, unknown>): void {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  }

  it("attaches an inbound user message to the assistant text leaf, not the toolResult", async () => {
    const file = writeHeader();
    appendRaw(file, {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    appendRaw(file, {
      type: "message",
      id: "assistant-toolcall-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "exec", arguments: {} }],
      },
    });
    appendRaw(file, {
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-toolcall-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
      },
    });
    appendRaw(file, {
      type: "message",
      id: "assistant-text-1",
      parentId: "tool-result-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    });

    const { messageId } = await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: { role: "user", content: [{ type: "text", text: "thanks!" }] },
    });

    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const appended = lines.find((entry: { id?: string }) => entry.id === messageId);
    expect(appended).toBeDefined();
    expect(appended.parentId).toBe("assistant-text-1");
  });

  it("attaches an inbound user message to the most-recent assistant message even when the leaf is a toolResult (orphan-pattern repro)", async () => {
    // This is the bug shape: the trailing assistant-text never lands (e.g. an
    // idempotency / delivery-mirror short-circuit returned without writing,
    // or the streaming-final write hasn't completed yet) and the on-disk leaf
    // is a toolResult. The user message must still attach to the assistant
    // turn so that on linearisation the conversational branch is preserved.
    const file = writeHeader();
    appendRaw(file, {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "search" }] },
    });
    appendRaw(file, {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "search", arguments: {} }],
      },
    });
    appendRaw(file, {
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "search",
        content: [{ type: "text", text: "result" }],
      },
    });

    const { messageId } = await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: { role: "user", content: [{ type: "text", text: "next" }] },
    });

    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const appended = lines.find((entry: { id?: string }) => entry.id === messageId);
    expect(appended).toBeDefined();
    // Before the fix: parentId === "tool-result-1" (sibling-orphan).
    // After the fix: parentId === "assistant-1" (the most-recent conversational entry).
    expect(appended.parentId).toBe("assistant-1");
  });

  it("non-user (e.g. assistant) appends preserve historical behaviour and use the trailing leaf", async () => {
    const file = writeHeader();
    appendRaw(file, {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "search" }] },
    });
    appendRaw(file, {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "search", arguments: {} }],
      },
    });
    appendRaw(file, {
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "search",
        content: [{ type: "text", text: "result" }],
      },
    });

    const { messageId } = await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the answer." }],
      },
    });

    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const appended = lines.find((entry: { id?: string }) => entry.id === messageId);
    expect(appended).toBeDefined();
    // Assistant follow-up to a tool result must remain a child of the toolResult
    // so the tool-call/tool-result chain stays intact within its turn.
    expect(appended.parentId).toBe("tool-result-1");
  });

  it("falls back to the trailing leaf when no conversational ancestor exists", async () => {
    const file = writeHeader();
    appendRaw(file, {
      type: "message",
      id: "tool-result-only",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "t-orphan",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
      },
    });

    const { messageId } = await appendSessionTranscriptMessage({
      transcriptPath: file,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const appended = lines.find((entry: { id?: string }) => entry.id === messageId);
    expect(appended).toBeDefined();
    expect(appended.parentId).toBe("tool-result-only");
  });

  it("serializes concurrent appenders so each entry parents on the most-recent on-disk leaf", async () => {
    // Belt-and-suspenders: even with the per-path queue the cross-process write
    // lock must serialise read+append within a single function, so two
    // concurrent appenders never both compute parentId from the same stale leaf.
    const file = writeHeader();
    appendRaw(file, {
      type: "message",
      id: "seed",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "seed" }] },
    });

    const results = await Promise.all([
      appendSessionTranscriptMessage({
        transcriptPath: file,
        message: { role: "user", content: [{ type: "text", text: "a" }] },
      }),
      appendSessionTranscriptMessage({
        transcriptPath: file,
        message: { role: "user", content: [{ type: "text", text: "b" }] },
      }),
      appendSessionTranscriptMessage({
        transcriptPath: file,
        message: { role: "user", content: [{ type: "text", text: "c" }] },
      }),
    ]);

    const lines = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Header + seed + three appended entries.
    expect(lines.length).toBe(5);
    const ids = new Set(lines.map((entry: { id?: string }) => entry.id));
    for (const r of results) {
      expect(ids.has(r.messageId)).toBe(true);
    }
    // Each appended entry's parentId must point at the previous on-disk entry.
    for (let i = 2; i < lines.length; i += 1) {
      expect(lines[i].parentId).toBe(lines[i - 1].id);
    }
  });
});
