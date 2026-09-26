import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
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

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

describe("runSessionCompactionIfNeeded stale totalTokens gating", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-stale-"));
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    incrementCompactionCountMock.mockReset().mockResolvedValue(1);
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
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

  it("does not compact when totalTokens is large but stale and the real transcript is small", async () => {
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
      totalTokensFresh: false,
    };
    await writeTestSessionStore(
      path.join(rootDir, "sessions.json"),
      "agent:main:main",
      sessionEntry,
    );

    const entry = await runWithEntry(sessionEntry, sessionFile);

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not compact on superseded display history behind a compaction boundary", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionFile = path.join(rootDir, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: false,
    };

    // Persist a compacted transcript whose retained display history exceeds the
    // threshold while the compacted model window stays small. Pressure gating must
    // follow the model window or budget compaction re-fires on healthy sessions.
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 1 });
    const source = SessionManager.open(scope);
    for (let index = 0; index < 64; index += 1) {
      source.appendMessage({
        role: "user",
        content: `superseded ${index} ${"x".repeat(8_000)}`,
        timestamp: index,
      });
    }
    const firstKept = source.appendMessage({
      role: "user",
      content: "kept tail prompt",
      timestamp: 64,
    });
    source.appendCompaction("summary", firstKept, 200_000);
    source.appendMessage({ role: "user", content: "after compaction", timestamp: 65 });
    await waitForSessionTranscriptProjection(scope);
    await writeTestSessionStore(storePath, "agent:main:main", sessionEntry);

    const entry = await runWithEntry(sessionEntry, sessionFile);

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("compacts when the compacted model window itself exceeds the threshold", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionFile = path.join(rootDir, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 200_000,
      totalTokensFresh: false,
    };

    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 1 });
    const source = SessionManager.open(scope);
    const firstKept = source.appendMessage({
      role: "user",
      content: "kept prompt",
      timestamp: 0,
    });
    source.appendCompaction("summary", firstKept, 100);
    for (let index = 0; index < 64; index += 1) {
      source.appendMessage({
        role: "user",
        content: `current ${index} ${"x".repeat(8_000)}`,
        timestamp: index + 1,
      });
    }
    await waitForSessionTranscriptProjection(scope);
    await writeTestSessionStore(storePath, "agent:main:main", sessionEntry);

    await runWithEntry(sessionEntry, sessionFile);

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("compacts when totalTokens is large and fresh", async () => {
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

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the routed account id into preflight compaction", async () => {
    // Group session keys carry no account identity, so if this launcher drops the
    // account the compaction path resolves the root history limit after prompt
    // preparation already used the account limit.
    const sessionFile = path.join(rootDir, "session.jsonl");
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

    await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
        agentAccountId: "work",
        conversationRoutePeerId: "peer",
        chatType: "direct",
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

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      agentAccountId: "work",
      conversationRoutePeerId: "peer",
      chatType: "direct",
    });
  });

  it.each([
    {
      name: "the configured roster default for an embedded provider",
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
      name: "the configured roster default before provider runtime selection",
      runAgentId: undefined,
      expectedAgentId: "ops",
      provider: "openai",
      model: "gpt-5.6-luna",
      expectsCompaction: false,
    },
    {
      name: "the explicitly prepared agent before provider runtime selection",
      runAgentId: "worker",
      expectedAgentId: "worker",
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
            list: [{ id: "ops", default: true }, { id: "worker" }],
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
});
