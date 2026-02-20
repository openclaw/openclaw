import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOLT_BINDLE_PROMPT_DEFAULT,
  DOLT_LEAF_PROMPT_DEFAULT,
  defaultPromptForMode,
  resolveDoltPromptTemplate,
} from "./prompts.js";

const tempFiles: string[] = [];

afterEach(async () => {
  for (const file of tempFiles.splice(0, tempFiles.length)) {
    await fs.rm(file, { recursive: true, force: true });
  }
});

async function writeTempPrompt(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dolt-prompt-test-"));
  const file = path.join(dir, "prompt.txt");
  await fs.writeFile(file, content, "utf8");
  tempFiles.push(dir);
  return file;
}

describe("defaultPromptForMode", () => {
  it("returns leaf default for leaf mode", () => {
    expect(defaultPromptForMode("leaf")).toBe(DOLT_LEAF_PROMPT_DEFAULT);
  });

  it("returns bindle default for bindle mode", () => {
    expect(defaultPromptForMode("bindle")).toBe(DOLT_BINDLE_PROMPT_DEFAULT);
  });

  it("returns bindle default for reset-short-bindle mode", () => {
    expect(defaultPromptForMode("reset-short-bindle")).toBe(DOLT_BINDLE_PROMPT_DEFAULT);
  });
});

describe("resolveDoltPromptTemplate", () => {
  it("returns built-in default when no override is set", async () => {
    const text = await resolveDoltPromptTemplate("leaf");
    expect(text).toBe(DOLT_LEAF_PROMPT_DEFAULT);
  });

  it("reads from override file path when provided", async () => {
    const customText = "Custom leaf summarization instructions go here.";
    const filePath = await writeTempPrompt(customText);
    const text = await resolveDoltPromptTemplate("leaf", { leafPromptPath: filePath });
    expect(text).toBe(customText);
  });

  it("uses bindle override for reset-short-bindle mode", async () => {
    const customText = "Custom bindle instructions for reset.";
    const filePath = await writeTempPrompt(customText);
    const text = await resolveDoltPromptTemplate("reset-short-bindle", {
      bindlePromptPath: filePath,
    });
    expect(text).toBe(customText);
  });

  it("throws on missing override file", async () => {
    await expect(
      resolveDoltPromptTemplate("leaf", { leafPromptPath: "/nonexistent/prompt.txt" }),
    ).rejects.toThrow(/not found/);
  });

  it("throws on empty override file", async () => {
    const filePath = await writeTempPrompt("   ");
    await expect(resolveDoltPromptTemplate("leaf", { leafPromptPath: filePath })).rejects.toThrow(
      /empty/,
    );
  });
});
