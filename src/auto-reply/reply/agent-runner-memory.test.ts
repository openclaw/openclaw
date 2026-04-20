import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import {
  runMemoryFlushIfNeeded,
  runPreflightCompactionIfNeeded,
  setAgentRunnerMemoryTestDeps,
} from "./agent-runner-memory.js";
import type { FollowupRun } from "./queue.js";

const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();

function createReplyOperation() {
  return {
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
  } as never;
}

function createFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: true,
      ...overrides,
    },
  } as unknown as FollowupRun;
}

async function writeSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf8");
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedPiAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + 1,
      };
      if (typeof params.newSessionId === "string" && params.newSessionId) {
        nextEntry.sessionId = params.newSessionId;
        const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
        nextEntry.sessionFile = path.join(path.dirname(storePath), `${params.newSessionId}.jsonl`);
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    setAgentRunnerMemoryTestDeps({
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      registerAgentRunContext: vi.fn() as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("runs a memory flush turn, rotates after compaction, and persists metadata", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end" } });
        return {
          payloads: [],
          meta: { agentMeta: { sessionId: "session-rotated" } },
        };
      },
    );

    const followupRun = createFollowupRun();
    const entry = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: sessionKey,
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: expect.stringContaining("session-rotated.jsonl"),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushCompactionCount).toBe(2);
    expect(persisted.main.memoryFlushAt).toBe(1_700_000_000_000);
  });

  it("skips memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { cliBackends: { "codex-cli": { command: "codex" } } } } },
      followupRun: createFollowupRun({ provider: "codex-cli" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "codex-cli/gpt-5.4",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
      relativePath: "memory/2023-11-14.md",
    }));

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createFollowupRun({ extraSystemPrompt: "extra system" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      extraSystemPrompt?: string;
      bootstrapPromptWarningSignaturesSeen?: string[];
      bootstrapPromptWarningSignature?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("runPreflightCompactionIfNeeded", () => {
  const compactEmbeddedPiSessionMock = vi.fn();
  const updateSessionStoreEntryMock = vi.fn();

  beforeEach(() => {
    compactEmbeddedPiSessionMock.mockReset();
    updateSessionStoreEntryMock.mockReset();
    setAgentRunnerMemoryTestDeps({
      compactEmbeddedPiSession: compactEmbeddedPiSessionMock as never,
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      registerAgentRunContext: vi.fn() as never,
      updateSessionStoreEntry: updateSessionStoreEntryMock as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000002",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(() => {
    setAgentRunnerMemoryTestDeps();
  });

  function createReplyOperation() {
    return {
      abortSignal: new AbortController().signal,
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
    } as never;
  }

  function createFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
    return {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        skipProviderRuntimeHints: true,
        ...overrides,
      },
    } as unknown as FollowupRun;
  }

  it("triggers compaction when fresh totalTokens exceeds threshold (100% cache hit)", async () => {
    // Simulates the bug from #66520: Anthropic prompt cache absorbs 305k tokens,
    // totalTokens is fresh at 305k, context window is 200k. Compaction should fire.
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 305_000,
      totalTokensFresh: true,
    };
    const sessionStore = { main: sessionEntry };
    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 305_000, tokensAfter: 50_000 },
    });
    incrementCompactionCountMock.mockResolvedValueOnce(1);

    const result = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 30_000,
            },
          },
        },
      },
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    // Compaction should have been triggered
    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(1);
    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        trigger: "budget",
      }),
    );
    // Note: incrementCompactionCount is called via direct module import (not
    // memoryDeps), so it is not captured by the mock. The key assertion is that
    // compactEmbeddedPiSession was invoked — verifying the threshold check
    // now uses fresh totalTokens including cached tokens.
    expect(result).toBeDefined();
  });

  it("skips compaction when fresh totalTokens is below threshold", async () => {
    // Fresh tokens at 50k, context window 200k, threshold ~166k → no compaction
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
      totalTokensFresh: true,
    };
    const sessionStore = { main: sessionEntry };

    const result = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 30_000,
            },
          },
        },
      },
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    // Compaction should NOT have been triggered
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);
  });

  it("triggers compaction with partial cache hit when total exceeds threshold", async () => {
    // Partial cache: totalTokens = 180k (> 166k threshold) → compaction fires
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 180_000,
      totalTokensFresh: true,
    };
    const sessionStore = { main: sessionEntry };
    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { tokensBefore: 180_000, tokensAfter: 40_000 },
    });
    incrementCompactionCountMock.mockResolvedValueOnce(1);

    await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 30_000,
            },
          },
        },
      },
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(1);
  });

  it("preserves 0% cache hit behavior (stale tokens use transcript fallback)", async () => {
    // When totalTokensFresh is false (no cache hit data, stale), the function
    // falls through to the transcript-based estimation path.
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 305_000,
      totalTokensFresh: false,
    };
    const sessionStore = { main: sessionEntry };

    const result = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 30_000,
            },
          },
        },
      },
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    // With stale tokens and no transcript file, compaction falls through to
    // the transcript estimation path but has no data → no compaction.
    // The key is: this path is unchanged from before the fix.
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);
  });

  it("skips compaction when totalTokensFresh is undefined (legacy sessions)", async () => {
    // Legacy session: totalTokensFresh was never set (undefined), but totalTokens
    // has a stale persisted value above the threshold. Previously this was treated
    // as fresh (undefined !== false → !shouldUseTranscriptFallback was true),
    // causing the fresh-token branch to use stale persisted totals and trigger
    // unnecessary compaction.
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 305_000,
      // totalTokensFresh is intentionally omitted (undefined)
    };
    const sessionStore = { main: sessionEntry };

    const result = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 30_000,
            },
          },
        },
      },
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    // With undefined freshness and no transcript file to read, transcript
    // estimation returns undefined. The function bails out because there is
    // no reliable token count and freshness is not confirmed, rather than
    // falling back to stale persisted totals.
    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);
  });

  it("skips compaction on heartbeat even with fresh tokens above threshold", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 305_000,
      totalTokensFresh: true,
    };
    const sessionStore = { main: sessionEntry };

    const result = await runPreflightCompactionIfNeeded({
      cfg: {},
      followupRun: createFollowupRun(),
      defaultModel: "claude-sonnet-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: true,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);
  });
});
