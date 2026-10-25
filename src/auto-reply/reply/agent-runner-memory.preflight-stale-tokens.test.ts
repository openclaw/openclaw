import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  createFreshSessionEntry,
  createMemoryFlushPlan,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const { compactEmbeddedAgentSessionMock, incrementCompactionCountMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: incrementCompactionCountMock,
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: vi.fn(),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-preflight-stale-");

describe("runSessionCompactionIfNeeded stale totalTokens gating", () => {
  let rootDir = "";

  beforeEach(() => {
    rootDir = sessionDirs.make();
    registerMemoryCapability("memory-core", {
      flushPlanResolver: createMemoryFlushPlan,
    });
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    incrementCompactionCountMock.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
  });

  async function runWithEntry(
    sessionEntry: SessionEntry,
    sessionFile: string,
    sessionKey = "agent:main:main",
    runOverrides: Parameters<typeof createTestFollowupRun>[0] = {},
  ) {
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionFile,
      sessionKey,
      ...runOverrides,
    });
    const defaultModel = "anthropic/claude-opus-4-6";
    return await runSessionCompactionIfNeeded({
      cfg: withTestModelContextTokens({
        cfg: {
          agents: {
            ...(sessionKey === "main" ? { entries: { ops: {} } } : {}),
            defaults: { compaction: { memoryFlush: {} } },
          },
        },
        followupRun,
        defaultModel,
        contextTokens: 100_000,
      }),
      followupRun,
      defaultModel,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),

      abortSignal: new AbortController().signal,
    });
  }

  async function oversizedEntry(sessionKey: string) {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
      "utf8",
    );
    const entry = createFreshSessionEntry({ sessionFile, totalTokens: 200_000 });
    await writeTestSessionStore(path.join(rootDir, "sessions.json"), sessionKey, entry);
    return { entry, sessionFile };
  }

  it("compacts fresh token totals above the model budget", async () => {
    const { entry, sessionFile } = await oversizedEntry("agent:main:main");
    await runWithEntry(entry, sessionFile);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "the sole configured agent for an embedded provider",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the sole configured agent before provider runtime selection",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
  ])(
    "resolves an unscoped session key with $name",
    async ({ provider, model, expectsCompaction }) => {
      const { entry: sessionEntry, sessionFile } = await oversizedEntry("main");
      const result = await runWithEntry(sessionEntry, sessionFile, "main", {
        agentId: undefined,
        provider,
        model,
      });

      expect(result).toBe(sessionEntry);
      if (expectsCompaction) {
        expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
          sessionTarget: { agentId: "ops" },
        });
      } else {
        expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      }
    },
  );

  it("excludes superseded oversized history from the active context budget", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, sessionEntry);
    const transcript = SessionManager.open(scope, rootDir);
    transcript.appendMessage({
      role: "user",
      content: "superseded history ".repeat(25_000),
      timestamp: 1,
    });
    const retained = transcript.appendMessage({ role: "user", content: "keep", timestamp: 2 });
    transcript.appendCompaction("Short summary", retained, 100_000);
    transcript.appendMessage({ role: "user", content: "latest", timestamp: 3 });
    await runWithEntry(sessionEntry, path.join(rootDir, "session.jsonl"));
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });
});
