import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRecentSessionContent } from "./transcript.js";

describe("getRecentSessionContent deduplicates assistant messages", () => {
  let tmpDir = "";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-dedup-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSession(file: string, lines: unknown[]): Promise<string> {
    const filePath = path.join(tmpDir, file);
    await fs.writeFile(
      filePath,
      lines.map((l) => JSON.stringify(l)).join("\n"),
      "utf-8",
    );
    return filePath;
  }

  it("deduplicates consecutive assistant messages with identical text", async () => {
    const filePath = await writeSession("dedup.jsonl", [
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "hello" } },
      { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "thinking", text: "thinking..." }, { type: "text", text: "Hi there!" }] } },
      { type: "message", id: "3", parentId: "2", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] } },
      { type: "message", id: "4", parentId: "3", message: { role: "user", content: "how are you?" } },
    ]);

    const result = await getRecentSessionContent(filePath);
    const lines = result!.split("\n");

    expect(lines).toEqual([
      "user: hello",
      "assistant: Hi there!",
      "user: how are you?",
    ]);
  });

  it("keeps distinct assistant messages unchanged", async () => {
    const filePath = await writeSession("distinct.jsonl", [
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: "first reply" } },
      { type: "message", id: "3", parentId: "2", message: { role: "user", content: "tell me more" } },
      { type: "message", id: "4", parentId: "3", message: { role: "assistant", content: "second reply" } },
    ]);

    const result = await getRecentSessionContent(filePath);
    const lines = result!.split("\n");

    expect(lines).toEqual([
      "user: hi",
      "assistant: first reply",
      "user: tell me more",
      "assistant: second reply",
    ]);
  });

  it("does not skip non-consecutive duplicates", async () => {
    const filePath = await writeSession("non-consecutive.jsonl", [
      { type: "message", id: "1", parentId: null, message: { role: "assistant", content: "hello there" } },
      { type: "message", id: "2", parentId: "1", message: { role: "user", content: "again" } },
      { type: "message", id: "3", parentId: "2", message: { role: "assistant", content: "hello there" } },
    ]);

    const result = await getRecentSessionContent(filePath);
    const lines = result!.split("\n");

    expect(lines).toEqual([
      "assistant: hello there",
      "user: again",
      "assistant: hello there",
    ]);
  });

  it("does not skip unrelated assistant messages with same text but no parentId lineage", async () => {
    const filePath = await writeSession("unrelated-same-text.jsonl", [
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "first msg" } },
      { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: "ok" } },
      { type: "message", id: "3", parentId: null, message: { role: "user", content: "second msg" } },
      { type: "message", id: "4", parentId: "3", message: { role: "assistant", content: "ok" } },
    ]);

    const result = await getRecentSessionContent(filePath);
    const lines = result!.split("\n");

    expect(lines).toEqual([
      "user: first msg",
      "assistant: ok",
      "user: second msg",
      "assistant: ok",
    ]);
  });

  it("does not skip assistant child with different text than parent", async () => {
    const filePath = await writeSession("diff-text-child.jsonl", [
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "thinking", text: "..." }, { type: "text", text: "Hello" }] } },
      { type: "message", id: "3", parentId: "2", message: { role: "assistant", content: "World" } },
    ]);

    const result = await getRecentSessionContent(filePath);
    const lines = result!.split("\n");

    expect(lines).toEqual([
      "user: hi",
      "assistant: Hello",
      "assistant: World",
    ]);
  });
});
