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
import { runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw } from "./agent-runner-memory.js";
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

type PreflightCompactionTestParams = Parameters<typeof runSessionCompactionIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runSessionCompactionIfNeeded(params: PreflightCompactionTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runSessionCompactionIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-preflight-stale-");

describe("runSessionCompactionIfNeeded stale totalTokens gating", () => {
  let rootDir = "";

  beforeEach(() => {
    rootDir = sessionDirs.make();
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        softThresholdTokens: 4_000,
        forceFlushTranscriptBytes: 1_000_000_000,
        reserveTokensFloor: 20_000,
        prompt: "Pre-compaction memory flush.\nNO_REPLY",
        systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
        relativePath: "memory/2023-11-14.md",
      }),
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

  async function runWithEntry(sessionEntry: SessionEntry, sessionFile: string) {
    return await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      abortSignal: new AbortController().signal,
    });
  }

  it("compacts fresh token totals above the model budget", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
      "utf8",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );
    await runWithEntry(sessionEntry, sessionFile);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "the sole configured agent for an embedded provider",
      expectedAgentId: "ops",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the sole configured agent before provider runtime selection",
      expectedAgentId: "ops",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
  ])(
    "resolves an unscoped session key with $name",
    async ({ expectedAgentId, provider, model, expectsCompaction }) => {
      const sessionFile = path.join(rootDir, "session.jsonl");
      const storePath = path.join(rootDir, "sessions.json");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
        "utf8",
      );
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        sessionFile,
        updatedAt: Date.now(),
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      };
      await writeTestSessionStore(storePath, "main", sessionEntry);

      const result = await runSessionCompactionIfNeeded({
        cfg: {
          agents: {
            entries: { ops: {} },
            defaults: { compaction: { memoryFlush: {} } },
          },
        },
        followupRun: createTestFollowupRun({
          agentId: undefined,
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
          provider,
          model,
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath,
        isHeartbeat: false,
        abortSignal: new AbortController().signal,
      });

      expect(result).toBe(sessionEntry);
      if (expectsCompaction) {
        expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
          sessionTarget: { agentId: expectedAgentId },
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
