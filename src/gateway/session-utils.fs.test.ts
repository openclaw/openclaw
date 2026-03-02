import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionMessagesAsync } from "./session-utils.fs.js";

describe("readSessionMessagesAsync", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeTmpFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-test-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("extracts message entries from JSONL transcript", async () => {
    const file = writeTmpFile(
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      ].join("\n"),
    );
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
    expect(messages[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("skips non-message entries", async () => {
    const file = writeTmpFile(
      [
        JSON.stringify({ type: "metadata", data: {} }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "tool_use", tool: "read" }),
      ].join("\n"),
    );
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("skips malformed lines", async () => {
    const file = writeTmpFile(
      [
        "not json at all",
        JSON.stringify({ type: "message", message: { role: "user", content: "ok" } }),
        "{broken json",
      ].join("\n"),
    );
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toHaveLength(1);
  });

  it("skips empty lines", async () => {
    const file = writeTmpFile(
      [
        "",
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        "",
        "  ",
        JSON.stringify({ type: "message", message: { role: "assistant", content: "world" } }),
      ].join("\n"),
    );
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toHaveLength(2);
  });

  it("returns empty array for empty file", async () => {
    const file = writeTmpFile("");
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toEqual([]);
  });

  it("skips entries where message is null/undefined", async () => {
    const file = writeTmpFile(
      [
        JSON.stringify({ type: "message", message: null }),
        JSON.stringify({ type: "message" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "valid" } }),
      ].join("\n"),
    );
    const messages = await readSessionMessagesAsync(file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "valid" });
  });
});
