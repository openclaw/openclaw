import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMessagesFromSessionTranscript } from "./session-transcript-messages.js";

describe("readMessagesFromSessionTranscript", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for undefined sessionFile", async () => {
    expect(await readMessagesFromSessionTranscript(undefined)).toBeNull();
  });

  it("returns null for missing file", async () => {
    expect(await readMessagesFromSessionTranscript("/nonexistent/file.jsonl")).toBeNull();
  });

  it("reads messages from JSONL transcript", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("preserves provenance field on messages", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const provenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:other-agent:main",
      sourceChannel: "discord",
      sourceTool: "sessions_send",
    };
    const lines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "from another agent", provenance },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "got it" },
      }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toHaveLength(2);
    expect(messages![0]).toEqual({
      role: "user",
      content: "from another agent",
      provenance,
    });
    // Assistant message has no provenance — should pass through unchanged
    expect(messages![1]).toEqual({ role: "assistant", content: "got it" });
  });

  it("skips malformed JSONL lines", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "valid" } }),
      "not valid json {{{",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "also valid" } }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toEqual([
      { role: "user", content: "valid" },
      { role: "assistant", content: "also valid" },
    ]);
  });

  it("skips non-message entries", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "system", data: { config: true } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "tool_call", data: { name: "bash" } }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("skips empty lines", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      "",
      "  ",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toHaveLength(2);
  });

  it("returns empty array for transcript with no messages", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "system", data: {} }) + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages).toEqual([]);
  });

  it("preserves all custom fields on messages", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const message = {
      role: "user",
      content: "test",
      provenance: { kind: "inter_session", sourceSessionKey: "agent:x:main" },
      customField: "preserved",
      metadata: { sender_id: "12345" },
    };
    await fs.writeFile(sessionFile, JSON.stringify({ type: "message", message }) + "\n");

    const messages = await readMessagesFromSessionTranscript(sessionFile);
    expect(messages![0]).toEqual(message);
  });
});
