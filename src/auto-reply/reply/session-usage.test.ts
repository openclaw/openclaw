import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionStore,
  saveSessionStore,
  type SessionSystemPromptReport,
  type SessionEntry,
} from "../../config/sessions.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

function buildSystemPromptReport(tokens: number): SessionSystemPromptReport {
  return {
    source: "run",
    generatedAt: tokens,
    systemPrompt: {
      chars: tokens,
      projectContextChars: 0,
      nonProjectContextChars: tokens,
    },
    injectedWorkspaceFiles: [],
    skills: {
      promptChars: 0,
      entries: [],
    },
    tools: {
      listChars: 0,
      schemaChars: 0,
      entries: [],
    },
  };
}

describe("persistSessionUsageUpdate", () => {
  it("preserves runtime route fields when preserveRuntimeModel is true", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-usage-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:main";
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now() - 1000,
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 128000,
      systemPromptReport: buildSystemPromptReport(12),
      inputTokens: 1,
      outputTokens: 2,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      providerUsed: "openai-codex",
      modelUsed: "gpt-5.5",
      contextTokensUsed: 256000,
      systemPromptReport: buildSystemPromptReport(99),
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1 },
      lastCallUsage: { input: 8, output: 4, cacheRead: 2, cacheWrite: 1 },
      cliSessionId: "codex-session",
      cliSessionBinding: { sessionId: "codex-session" },
      preserveRuntimeModel: true,
    });

    const saved = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(saved?.modelProvider).toBe("openai");
    expect(saved?.model).toBe("gpt-5.5");
    expect(saved?.contextTokens).toBe(128000);
    expect(saved?.systemPromptReport).toEqual(buildSystemPromptReport(12));
    expect(saved?.cliSessionIds?.["openai-codex"]).toBeUndefined();
    expect(saved?.cliSessionBindings?.["openai-codex"]).toBeUndefined();
    expect(saved?.inputTokens).toBe(10);
    expect(saved?.outputTokens).toBe(5);
    expect(saved?.cacheRead).toBe(2);
    expect(saved?.cacheWrite).toBe(1);
    expect(saved?.totalTokensFresh).toBe(true);
  });
});
