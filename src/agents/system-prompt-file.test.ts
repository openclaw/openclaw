import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSystemPromptFile } from "./system-prompt-file.js";

describe("readSystemPromptFile", () => {
  const tmpFiles: string[] = [];

  function writeTmp(content: string): string {
    const filePath = path.join(os.tmpdir(), `system-prompt-test-${Date.now()}-${Math.random()}.md`);
    fs.writeFileSync(filePath, content, "utf-8");
    tmpFiles.push(filePath);
    return filePath;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    tmpFiles.length = 0;
  });

  it("returns undefined when filePath is undefined", () => {
    expect(readSystemPromptFile(undefined)).toBeUndefined();
  });

  it("returns undefined when filePath is empty string", () => {
    expect(readSystemPromptFile("")).toBeUndefined();
  });

  it("returns file contents when file exists", () => {
    const filePath = writeTmp("You are a helpful assistant.");
    expect(readSystemPromptFile(filePath)).toBe("You are a helpful assistant.");
  });

  it("trims whitespace from file contents", () => {
    const filePath = writeTmp("  \n  Be concise.  \n  ");
    expect(readSystemPromptFile(filePath)).toBe("Be concise.");
  });

  it("returns undefined for empty file", () => {
    const filePath = writeTmp("");
    expect(readSystemPromptFile(filePath)).toBeUndefined();
  });

  it("returns undefined for whitespace-only file", () => {
    const filePath = writeTmp("   \n\n   ");
    expect(readSystemPromptFile(filePath)).toBeUndefined();
  });

  it("returns undefined when file does not exist", () => {
    expect(readSystemPromptFile("/nonexistent/path/prompt.md")).toBeUndefined();
  });

  it("handles multiline content", () => {
    const content = "# Instructions\n\nBe polite.\nDo not share secrets.";
    const filePath = writeTmp(content);
    expect(readSystemPromptFile(filePath)).toBe(content);
  });
});
