import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRecentSessionContent } from "./transcript.js";

describe("getRecentSessionContent — chat-template token sanitization (regression for #69943)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-transcript-"));
    file = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeMessage(role: string, content: unknown): Promise<void> {
    const line = JSON.stringify({ type: "message", message: { role, content } });
    await fs.writeFile(file, line);
  }

  it("strips ChatML tokens from string content", async () => {
    await writeMessage("assistant", "Hello<|im_end|><|endoftext|>");
    const out = (await getRecentSessionContent(file)) ?? "";
    expect(out).not.toContain("<|im_end|>");
    expect(out).not.toContain("<|endoftext|>");
    expect(out).toContain("Hello");
  });

  it("strips Llama-family tokens from text-block content", async () => {
    await writeMessage("user", [{ type: "text", text: "ask<|begin_of_text|><|eot_id|>" }]);
    const out = (await getRecentSessionContent(file)) ?? "";
    expect(out).not.toContain("<|begin_of_text|>");
    expect(out).not.toContain("<|eot_id|>");
    expect(out).toContain("ask");
  });

  it("strips reserved-special-token variants", async () => {
    await writeMessage("assistant", "x<|reserved_special_token_42|>y");
    const out = (await getRecentSessionContent(file)) ?? "";
    expect(out).not.toContain("<|reserved_special_token_42|>");
    expect(out).toContain("x");
    expect(out).toContain("y");
  });

  it("preserves clean content unchanged", async () => {
    await writeMessage("user", "what's the weather?");
    const out = await getRecentSessionContent(file);
    expect(out).toBe("user: what's the weather?");
  });
});
