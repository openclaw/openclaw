import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry } from "./session-files.js";

// Helpers for constructing inbound metadata blocks (mirrors format in inbound-meta.ts)
function makeConvBlock(extra: Record<string, string> = {}): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ message_id: "msg-1", sender: "TestUser", ...extra }, null, 2),
    "```",
  ].join("\n");
}

function makeUserMessageLine(content: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content } });
}

describe("buildSessionEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-entry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real session JSONL file with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("skips blank lines and invalid JSON without breaking lineMap", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
    ];
    const filePath = path.join(tmpDir, "gaps.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
  });

  it("strips 'Conversation info (untrusted metadata):' block from indexed text", async () => {
    // User message with prepended OpenClaw inbound metadata block
    const userContent = [makeConvBlock(), "", "What is the weather today?"].join("\n");
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "meta-conv.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(1);
    // Metadata JSON should not appear in the indexed text
    expect(entry!.content).not.toContain("Conversation info");
    expect(entry!.content).not.toContain("untrusted metadata");
    expect(entry!.content).not.toContain("message_id");
    // The actual user message should be preserved
    expect(entry!.content).toContain("What is the weather today?");
  });

  it("strips [[reply_to_current]] inline directive tags from indexed text", async () => {
    // User message containing an inline reply directive tag
    const userContent = "[[reply_to_current]] Can you explain that again?";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "reply-tag.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The [[reply_to_current]] tag should be stripped
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // The actual message text should be preserved
    expect(entry!.content).toContain("Can you explain that again?");
  });

  it("preserves normal message content without modification", async () => {
    // Plain user and assistant messages with no injected metadata
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Tell me about TypeScript generics." },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "TypeScript generics allow you to write reusable typed code.",
        },
      }),
    ];
    const filePath = path.join(tmpDir, "normal.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(2);
    expect(contentLines[0]).toContain("User: Tell me about TypeScript generics.");
    expect(contentLines[1]).toContain(
      "Assistant: TypeScript generics allow you to write reusable typed code.",
    );
  });

  it("strips multiple metadata blocks followed by actual user text", async () => {
    // Real-world inbound messages often have several injected blocks stacked:
    // Conversation info block + Sender info block, then blank line, then actual text.
    // All injected blocks must be stripped; only the real content is indexed.
    const senderBlock = [
      "Sender (untrusted metadata):",
      "```json",
      JSON.stringify({ label: "Kebabman (484946046)", id: "484946046", name: "Kebabman" }, null, 2),
      "```",
    ].join("\n");
    const userContent = [makeConvBlock(), "", senderBlock, "", "Show me today's schedule."].join(
      "\n",
    );
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "multi-meta.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // None of the injected metadata fields should appear in the indexed text
    expect(entry!.content).not.toContain("Conversation info");
    expect(entry!.content).not.toContain("Sender (untrusted metadata)");
    expect(entry!.content).not.toContain("untrusted metadata");
    expect(entry!.content).not.toContain("message_id");
    expect(entry!.content).not.toContain("484946046");
    expect(entry!.content).not.toContain("Kebabman");
    // The real user message is preserved
    expect(entry!.content).toContain("Show me today's schedule.");
  });

  it("produces no indexed entry when message is only a [[reply_to_current]] tag", async () => {
    // If the entire message content is ONLY an inline directive tag and nothing
    // else, stripping it must leave an empty result — the entry must not be
    // indexed at all (the message line is silently skipped).
    const userContent = "[[reply_to_current]]";
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "tag-only.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // No indexable content — the content string should be empty and lineMap empty.
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("strips metadata block and mid-text reply tag, preserving surrounding content", async () => {
    // A user message that has a metadata prefix block AND an inline directive
    // tag embedded within the actual text body.
    // Both forms of injection must be stripped; the surrounding real content is kept.
    const realText =
      "[[reply_to_current]] Can you summarise the thread? Also, what was the final decision?";
    const userContent = [makeConvBlock(), "", realText].join("\n");
    const jsonlLines = [makeUserMessageLine(userContent)];
    const filePath = path.join(tmpDir, "mixed-meta-tag.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // Injected noise must be absent
    expect(entry!.content).not.toContain("Conversation info");
    expect(entry!.content).not.toContain("untrusted metadata");
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // Both fragments of the real text must be present
    expect(entry!.content).toContain("Can you summarise the thread?");
    expect(entry!.content).toContain("what was the final decision?");
  });

  it("strips [[reply_to_current]] tag from assistant-role messages", async () => {
    // extractAndStripSessionText is called for both user and assistant roles.
    // An assistant message that somehow contains a reply directive tag must also
    // be stripped — the tag must not leak into the indexed transcript.
    const assistantContent =
      "[[reply_to_current]] Here is the summary you asked for: three key points.";
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: assistantContent },
      }),
    ];
    const filePath = path.join(tmpDir, "assistant-tag.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The directive tag must be stripped from the indexed assistant content
    expect(entry!.content).not.toContain("[[reply_to_current]]");
    // The actual assistant text is preserved
    expect(entry!.content).toContain("Here is the summary you asked for: three key points.");
    // Entry is indexed as assistant content
    expect(entry!.content).toContain("Assistant:");
    expect(entry!.lineMap).toEqual([1]);
  });
});
