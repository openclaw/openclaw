import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw } from "./agent-runner-memory.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import { createMockReplyOperation } from "./test-helpers.js";

const compactEmbeddedAgentSessionMock = vi.hoisted(() => vi.fn());
const incrementCompactionCountMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  runEmbeddedAgent: vi.fn(),
}));
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../infra/agent-run-registry.js", () => ({
  registerAgentRunContext: vi.fn(),
  clearAgentRunContext: vi.fn(),
}));
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: incrementCompactionCountMock }));

async function writeTestSessionTranscript(params: {
  rootDir: string;
  events: Parameters<typeof replaceTranscriptEvents>[1];
  sessionKey: string;
}): Promise<void> {
  const scope = {
    agentId: "main",
    sessionId: "session",
    sessionKey: params.sessionKey,
    storePath: path.join(params.rootDir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  await replaceTranscriptEvents(scope, params.events);
  await waitForSessionTranscriptProjection(scope);
}

async function runCompaction(params: {
  rootDir: string;
  sessionKey: string;
  storePath: string;
  sessionEntry: SessionEntry;
}) {
  const followupRun = createTestFollowupRun({
    provider: "anthropic",
    model: "claude",
    sessionId: "session",
    sessionKey: params.sessionKey,
  });
  const { replyOperation } = createMockReplyOperation({ key: "test" });
  return await runSessionCompactionIfNeededRaw({
    cfg: withTestModelContextTokens({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun,
      defaultModel: "anthropic/claude",
      contextTokens: 100_000,
    }),
    followupRun,
    promptForEstimate: "",
    defaultModel: "anthropic/claude",
    sessionEntry: params.sessionEntry,
    sessionStore: { [params.sessionKey]: params.sessionEntry },
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    isHeartbeat: false,
    abortSignal: replyOperation.abortSignal,
    onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
    onSessionIdChanged: (sessionId) => replyOperation.updateSessionId(sessionId),
  });
}

describe("CLI context usage compaction accounting", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-usage-"));
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
      result: { tokensAfter: 42, sessionId: "session" },
    });
    incrementCompactionCountMock.mockReset().mockResolvedValue(1);
  });

  afterEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("sizes preflight from the context marker when counters cover the whole turn", async () => {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "sessions.json");
    await writeTestSessionTranscript({
      rootDir,
      sessionKey,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            api: "cli",
            content: "multi-call turn",
            usage: {
              input: 135_864,
              output: 30_000,
              cacheRead: 37_888,
              totalTokens: 203_752,
              contextUsage: { state: "available", promptTokens: 86_876, totalTokens: 88_876 },
            },
          },
        },
      ],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
      compactionCount: 0,
    };

    await runCompaction({ rootDir, sessionKey, storePath, sessionEntry });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      currentTokenCount: 88_876,
    });
  });
});
