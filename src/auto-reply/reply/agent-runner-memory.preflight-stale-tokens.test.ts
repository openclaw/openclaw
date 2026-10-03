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

  async function runWithEntry(
    sessionEntry: SessionEntry,
    sessionFile: string,
    route: Parameters<typeof createTestFollowupRun>[0] = {},
  ) {
    return await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
        ...route,
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath: path.join(rootDir, "sessions.json"),
      abortSignal: new AbortController().signal,
    });
  }

  it.each([
    { name: "stale", fresh: false, routed: false },
    { name: "fresh", fresh: true, routed: false },
    { name: "fresh with routed account", fresh: true, routed: true },
  ])("gates $name token totals against a small transcript", async ({ fresh, routed }) => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    if (!routed) {
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
        "utf8",
      );
    }
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: fresh,
      ...(fresh ? { totalTokensVersion: 1 } : {}),
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );
    const route: Parameters<typeof createTestFollowupRun>[0] = routed
      ? { agentAccountId: "work", conversationRoutePeerId: "peer", chatType: "direct" }
      : {};
    const entry = await runWithEntry(sessionEntry, sessionFile, route);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(fresh ? 1 : 0);
    if (!fresh) {
      expect(entry).toBe(sessionEntry);
    }
    if (routed) {
      expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject(route);
    }
  });

  it.each([
    {
      name: "the sole configured agent for an embedded provider",
      runAgentId: undefined,
      expectedAgentId: "ops",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the explicitly prepared agent for an embedded provider",
      runAgentId: "worker",
      expectedAgentId: "worker",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectsCompaction: true,
    },
    {
      name: "the sole configured agent before provider runtime selection",
      runAgentId: undefined,
      expectedAgentId: "ops",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
  ])(
    "resolves an unscoped session key with $name",
    async ({ runAgentId, expectedAgentId, provider, model, expectsCompaction }) => {
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
            entries: runAgentId ? { ops: {}, worker: {} } : { ops: {} },
            defaults: { compaction: { memoryFlush: {} } },
          },
        },
        followupRun: createTestFollowupRun({
          agentId: runAgentId,
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

  it.each(["superseded", "active", "excluded"] as const)(
    "budgets only active context with %s oversized history",
    async (history) => {
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
      if (history === "excluded") {
        transcript.appendMessage({
          role: "custom",
          customType: "activity",
          content: "display only ".repeat(25_000),
          display: true,
          excludeFromContext: true,
          timestamp: 1,
        });
      } else {
        if (history === "superseded") {
          transcript.appendMessage({
            role: "user",
            content: "superseded history ".repeat(25_000),
            timestamp: 1,
          });
        }
        const retained = transcript.appendMessage({
          role: "user",
          content: "keep",
          timestamp: history === "superseded" ? 2 : 1,
        });
        transcript.appendCompaction(
          "Short summary",
          retained,
          history === "superseded" ? 100_000 : 100,
        );
        transcript.appendMessage({
          role: "user",
          content: history === "superseded" ? "latest" : "active history ".repeat(25_000),
          timestamp: history === "superseded" ? 3 : 2,
        });
      }
      await runWithEntry(sessionEntry, path.join(rootDir, "session.jsonl"));
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(history === "active" ? 1 : 0);
    },
  );
});
