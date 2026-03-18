import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildImplicitMemoryWriteback,
  isAutoMemoryEnabled,
  resolveImplicitMemoryScopeKey,
  retrieveImplicitContext,
  saveImplicitExperience,
} from "./implicit-memory.runtime.js";

describe("implicit memory runtime", () => {
  let dbPath: string;
  let previousDbPath: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-implicit-memory-"));
    dbPath = path.join(tempDir, "implicit-memory.db");
    previousDbPath = process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH;
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH = dbPath;
  });

  afterEach(async () => {
    if (previousDbPath === undefined) {
      delete process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH;
    } else {
      process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH = previousDbPath;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
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

  it("prefers sender-based scoping when sender metadata is available", () => {
    expect(
      resolveImplicitMemoryScopeKey({
        sessionId: "session-1",
        sessionKey: "agent:main:discord:channel:abc",
        messageChannel: "discord",
        agentAccountId: "acct-1",
        senderId: "user-42",
      }),
    ).toBe("sender:discord:acct-1:user-42");
  });

  it("falls back to session scoping when sender metadata is unavailable", () => {
    expect(
      resolveImplicitMemoryScopeKey({
        sessionId: "session-1",
        sessionKey: "agent:main:discord:channel:abc",
      }),
    ).toBe("session:agent:main:discord:channel:abc");
  });

  it("keeps sender-scoped keys isolated across channel accounts", () => {
    expect(
      resolveImplicitMemoryScopeKey({
        sessionId: "session-1",
        messageChannel: "discord",
        agentAccountId: "acct-a",
        senderId: "user-42",
      }),
    ).not.toBe(
      resolveImplicitMemoryScopeKey({
        sessionId: "session-2",
        messageChannel: "discord",
        agentAccountId: "acct-b",
        senderId: "user-42",
      }),
    );
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
      scopeKey: "sender:slack:user-weather",
      intent: "query weather",
      rules: "Always use Celsius and return JSON.",
    });
    await saveImplicitExperience({
      scopeKey: "sender:slack:user-coffee",
      intent: "coffee preference",
      rules: "Default to oat milk and no sugar.",
    });
    await saveImplicitExperience({
      scopeKey: "sender:slack:user-calendar",
      intent: "calendar scheduling",
      rules: "Prefer 30 minute meetings in the afternoon.",
    });

    const context = await retrieveImplicitContext(
      "What is tomorrow's weather?",
      "sender:slack:user-weather",
    );

    expect(await fs.stat(dbPath)).toBeTruthy();
    expect(context).toContain("Always use Celsius and return JSON.");
    expect(context).toContain("query weather");
  });

  it("returns null when no implicit memory matches the query", async () => {
    await saveImplicitExperience({
      scopeKey: "sender:slack:user-coffee",
      intent: "coffee preference",
      rules: "Default to oat milk and no sugar.",
    });

    await expect(
      retrieveImplicitContext("Explain TCP congestion control", "sender:slack:user-coffee"),
    ).resolves.toBeNull();
  });

  it("does not retrieve memories from a different scope", async () => {
    await saveImplicitExperience({
      scopeKey: "sender:discord:user-a",
      intent: "query weather",
      rules: "Always use Celsius and return JSON.",
    });
    await saveImplicitExperience({
      scopeKey: "sender:discord:user-b",
      intent: "query weather",
      rules: "Always use Fahrenheit and plain text.",
    });

    const context = await retrieveImplicitContext(
      "What is tomorrow's weather?",
      "sender:discord:user-b",
    );

    expect(context).toContain("Always use Fahrenheit and plain text.");
    expect(context).not.toContain("Always use Celsius and return JSON.");
  });

  it("passes argv values safely when the query starts with a dash", async () => {
    await saveImplicitExperience({
      scopeKey: "sender:discord:user-dash",
      intent: "- summarize this",
      rules: "Preserve leading dashes in stored prompts.",
    });

    const context = await retrieveImplicitContext("- summarize this", "sender:discord:user-dash");

    expect(context).toContain("Preserve leading dashes in stored prompts.");
  });

  it("stores implicit memory under OPENCLAW_STATE_DIR when no DB override is set", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-implicit-memory-state-"));
    delete process.env.OPENCLAW_IMPLICIT_MEMORY_DB_PATH;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await saveImplicitExperience({
      scopeKey: "sender:discord:user-state-dir",
      intent: "query weather",
      rules: "Store under the active state dir.",
    });

    await expect(fs.stat(path.join(stateDir, "implicit_memory.db"))).resolves.toBeTruthy();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("avoids false-positive matches on shared common words", async () => {
    await saveImplicitExperience({
      scopeKey: "sender:discord:user-help",
      intent: "help me write a poem",
      rules: "Use rhyming couplets and 8-syllable lines.",
    });

    await expect(
      retrieveImplicitContext("Can you help me deploy this container?", "sender:discord:user-help"),
    ).resolves.toBeNull();
  });

  it("skips retrieval when the prompt only contains common words", async () => {
    await saveImplicitExperience({
      scopeKey: "sender:discord:user-common-words",
      intent: "can you write a poem",
      rules: "Use rhyming couplets and 8-syllable lines.",
    });

    await expect(
      retrieveImplicitContext("what can you do", "sender:discord:user-common-words"),
    ).resolves.toBeNull();
  });

  it("filters overlap after scoring a wider FTS candidate set", async () => {
    for (let index = 0; index < 8; index += 1) {
      await saveImplicitExperience({
        scopeKey: "sender:discord:user-deploy",
        intent: `deploy noise ${index}`,
        rules: "deploy",
      });
    }

    await saveImplicitExperience({
      scopeKey: "sender:discord:user-deploy",
      intent: "deploy container rollout",
      rules: "Prefer blue-green deployment for container workloads in production environments.",
    });

    const context = await retrieveImplicitContext(
      "deploy container production",
      "sender:discord:user-deploy",
    );

    expect(context).toContain("deploy container rollout");
    expect(context).toContain("blue-green deployment");
  });
});
