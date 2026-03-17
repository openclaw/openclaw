import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildImplicitMemoryWriteback,
  isAutoMemoryEnabled,
  retrieveImplicitContext,
  saveImplicitExperience,
} from "./implicit-memory.runtime.js";

describe("implicit memory runtime", () => {
  let dbPath: string;
  let previousDbPath: string | undefined;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-implicit-memory-"));
    dbPath = path.join(tempDir, "implicit-memory.db");
    previousDbPath = process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH;
    process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH = dbPath;
  });

  afterEach(async () => {
    if (previousDbPath === undefined) {
      delete process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH;
    } else {
      process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH = previousDbPath;
    }
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("treats auto memory as disabled by default", () => {
    expect(isAutoMemoryEnabled(undefined)).toBe(false);
    expect(isAutoMemoryEnabled({})).toBe(false);
    expect(isAutoMemoryEnabled({ memory: { implicit: { enabled: false } } } as never)).toBe(false);
  });

  it("enables auto memory only when the config flag is true", () => {
    expect(isAutoMemoryEnabled({ memory: { implicit: { enabled: true } } } as never)).toBe(true);
  });

  it("builds a writeback payload from the user input and assistant output", () => {
    expect(
      buildImplicitMemoryWriteback({
        userInput: "Remember that I prefer decaf after lunch",
        assistantTexts: ["I'll keep that in mind for future coffee suggestions."],
        success: true,
      }),
    ).toEqual({
      intent: "Remember that I prefer decaf after lunch",
      rules:
        "Outcome: success\nAssistant output: I'll keep that in mind for future coffee suggestions.",
    });
  });

  it("falls back to the error text when the turn fails", () => {
    expect(
      buildImplicitMemoryWriteback({
        userInput: "Book a meeting for tomorrow",
        assistantTexts: [],
        success: false,
        error: "calendar provider unavailable",
      }),
    ).toEqual({
      intent: "Book a meeting for tomorrow",
      rules: "Outcome: failure\nError: calendar provider unavailable",
    });
  });

  it("stores experiences in an isolated temp database and retrieves matching context", async () => {
    await saveImplicitExperience({
      intent: "query weather",
      rules: "Always use Celsius and return JSON.",
    });
    await saveImplicitExperience({
      intent: "coffee preference",
      rules: "Default to oat milk and no sugar.",
    });
    await saveImplicitExperience({
      intent: "calendar scheduling",
      rules: "Prefer 30 minute meetings in the afternoon.",
    });

    const context = await retrieveImplicitContext("What is tomorrow's weather?");

    expect(await fs.stat(dbPath)).toBeTruthy();
    expect(context).toContain("Always use Celsius and return JSON.");
    expect(context).toContain("query weather");
  });

  it("returns null when no implicit memory matches the query", async () => {
    await saveImplicitExperience({
      intent: "coffee preference",
      rules: "Default to oat milk and no sugar.",
    });

    await expect(retrieveImplicitContext("Explain TCP congestion control")).resolves.toBeNull();
  });
});
