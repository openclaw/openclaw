import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

const runEmbeddedPiAgentMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();

let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;
let loadSessionStore: typeof import("../../config/sessions/store.js").loadSessionStore;
let saveSessionStore: typeof import("../../config/sessions/store.js").saveSessionStore;
let clearFollowupQueue: typeof import("./queue.js").clearFollowupQueue;
let enqueueFollowupRun: typeof import("./queue.js").enqueueFollowupRun;
let sessionRunAccounting: typeof import("./session-run-accounting.js");
let createMockFollowupRun: typeof import("./test-helpers.js").createMockFollowupRun;
let createMockTypingController: typeof import("./test-helpers.js").createMockTypingController;
const FOLLOWUP_DEBUG = process.env.OPENCLAW_DEBUG_FOLLOWUP_RUNNER_TEST === "1";
const FOLLOWUP_TEST_QUEUES = new Map<
  string,
  {
    items: FollowupRun[];
    lastRun?: FollowupRun["run"];
  }
>();

function debugFollowupTest(message: string): void {
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  process.stderr.write(`[followup-runner.test] ${message}\n`);
}

async function incrementRunCompactionCountForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").incrementRunCompactionCount>[0],
): Promise<number | undefined> {
  const {
    sessionStore,
    sessionKey,
    sessionEntry,
    amount = 1,
    newSessionId,
    lastCallUsage,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }

  const nextCount = Math.max(0, entry.compactionCount ?? 0) + Math.max(0, amount);
  const nextEntry: SessionEntry = {
    ...entry,
    compactionCount: nextCount,
    updatedAt: Date.now(),
  };
  if (newSessionId && newSessionId !== entry.sessionId) {
    nextEntry.sessionId = newSessionId;
    if (entry.sessionFile?.trim()) {
      nextEntry.sessionFile = path.join(path.dirname(entry.sessionFile), `${newSessionId}.jsonl`);
    }
  }
  const promptTokens =
    (lastCallUsage?.input ?? 0) +
    (lastCallUsage?.cacheRead ?? 0) +
    (lastCallUsage?.cacheWrite ?? 0);
  if (promptTokens > 0) {
    nextEntry.totalTokens = promptTokens;
    nextEntry.totalTokensFresh = true;
    nextEntry.inputTokens = undefined;
    nextEntry.outputTokens = undefined;
    nextEntry.cacheRead = undefined;
    nextEntry.cacheWrite = undefined;
  }

  sessionStore[sessionKey] = nextEntry;
  if (sessionEntry) {
    Object.assign(sessionEntry, nextEntry);
  }
  return nextCount;
}

function getFollowupTestQueue(key: string): {
  items: FollowupRun[];
  lastRun?: FollowupRun["run"];
} {
  const cleaned = key.trim();
  const existing = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (existing) {
    return existing;
  }
  const created = {
    items: [] as FollowupRun[],
    lastRun: undefined as FollowupRun["run"] | undefined,
  };
  FOLLOWUP_TEST_QUEUES.set(cleaned, created);
  return created;
}

function clearFollowupQueueForFollowupTest(key: string): number {
  const cleaned = key.trim();
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length;
  FOLLOWUP_TEST_QUEUES.delete(cleaned);
  return cleared;
}

function enqueueFollowupRunForFollowupTest(key: string, run: FollowupRun): boolean {
  const queue = getFollowupTestQueue(key);
  queue.items.push(run);
  queue.lastRun = run.run;
  return true;
}

function refreshQueuedFollowupSessionForFollowupTest(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
}): void {
  const cleaned = params.key.trim();
  if (!cleaned || !params.previousSessionId || !params.nextSessionId) {
    return;
  }
  if (params.previousSessionId === params.nextSessionId) {
    return;
  }
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return;
  }
  const rewrite = (run?: FollowupRun["run"]) => {
    if (!run || run.sessionId !== params.previousSessionId) {
      return;
    }
    run.sessionId = params.nextSessionId!;
    if (params.nextSessionFile?.trim()) {
      run.sessionFile = params.nextSessionFile;
    }
  };
  rewrite(queue.lastRun);
  for (const item of queue.items) {
    rewrite(item.run);
  }
}

async function persistRunSessionUsageForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").persistRunSessionUsage>[0],
): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextEntry: SessionEntry = {
    ...entry,
    updatedAt: Date.now(),
    modelProvider: params.providerUsed ?? entry.modelProvider,
    model: params.modelUsed ?? entry.model,
    contextTokens: params.contextTokensUsed ?? entry.contextTokens,
    systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
  };
  if (params.usage) {
    nextEntry.inputTokens = params.usage.input ?? 0;
    nextEntry.outputTokens = params.usage.output ?? 0;
    const cacheUsage = params.lastCallUsage ?? params.usage;
    nextEntry.cacheRead = cacheUsage?.cacheRead ?? 0;
    nextEntry.cacheWrite = cacheUsage?.cacheWrite ?? 0;
  }
  const promptTokens =
    params.promptTokens ??
    (params.lastCallUsage?.input ?? params.usage?.input ?? 0) +
      (params.lastCallUsage?.cacheRead ?? params.usage?.cacheRead ?? 0) +
      (params.lastCallUsage?.cacheWrite ?? params.usage?.cacheWrite ?? 0);
  nextEntry.totalTokens = promptTokens > 0 ? promptTokens : undefined;
  nextEntry.totalTokensFresh = promptTokens > 0;
  store[sessionKey] = nextEntry;
  await saveSessionStore(storePath, store);
}

async function loadFreshFollowupRunnerModuleForTest() {
  vi.resetModules();
  vi.doMock(
    "../../agents/model-fallback.js",
    async () => await import("../../test-utils/model-fallback.mock.js"),
  );
  vi.doMock("../../agents/session-write-lock.js", () => ({
    acquireSessionWriteLock: vi.fn(async () => ({
      release: async () => {},
    })),
  }));
  vi.doMock("../../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn(async () => false),
    compactEmbeddedPiSession: (params: unknown) => compactEmbeddedPiSessionMock(params),
    isEmbeddedPiRunActive: vi.fn(() => false),
    isEmbeddedPiRunStreaming: vi.fn(() => false),
    queueEmbeddedPiMessage: vi.fn(async () => undefined),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
    waitForEmbeddedPiRunEnd: vi.fn(async () => undefined),
  }));
  vi.doMock("./queue.js", () => ({
    clearFollowupQueue: clearFollowupQueueForFollowupTest,
    enqueueFollowupRun: enqueueFollowupRunForFollowupTest,
    refreshQueuedFollowupSession: refreshQueuedFollowupSessionForFollowupTest,
  }));
  vi.doMock("./session-run-accounting.js", () => ({
    persistRunSessionUsage: persistRunSessionUsageForFollowupTest,
    incrementRunCompactionCount: incrementRunCompactionCountForFollowupTest,
  }));
  vi.doMock("./route-reply.js", () => ({
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  }));
  ({ createFollowupRunner } = await import("./followup-runner.js"));
  ({ loadSessionStore, saveSessionStore } = await import("../../config/sessions/store.js"));
  ({ clearFollowupQueue, enqueueFollowupRun } = await import("./queue.js"));
  sessionRunAccounting = await import("./session-run-accounting.js");
  ({ createMockFollowupRun, createMockTypingController } = await import("./test-helpers.js"));
}

const ROUTABLE_TEST_CHANNELS = new Set([
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "whatsapp",
  "feishu",
]);

beforeEach(async () => {
  await loadFreshFollowupRunnerModuleForTest();
  runEmbeddedPiAgentMock.mockReset();
  compactEmbeddedPiSessionMock.mockReset();
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
});

afterEach(async () => {
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  const { clearSessionStoreCacheForTest } = await import("../../config/sessions/store.js");
  clearSessionStoreCacheForTest();
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  const handles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles?.()
    .map((handle) => handle?.constructor?.name ?? typeof handle);
  debugFollowupTest(`active handles: ${JSON.stringify(handles ?? [])}`);
  const requests = (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })
    ._getActiveRequests?.()
    .map((request) => request?.constructor?.name ?? typeof request);
  debugFollowupTest(`active requests: ${JSON.stringify(requests ?? [])}`);
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  createMockFollowupRun({ run: { messageProvider } });

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  return createMockFollowupRun(overrides);
}

async function normalizeComparablePath(filePath: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
  return path.join(parent, path.basename(filePath));
}

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry, completed: true },
      });
      return params.result;
    },
  );
}

function createAsyncReplySpy() {
  return vi.fn(async () => {});
}

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-meta-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 2,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(2);
    expect(sessionStore.main.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(sessionStore.main.sessionFile ?? "")).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("refreshes queued followup runs to the rotated transcript", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-queue-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 1,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queuedNext = createQueuedRun({
      prompt: "next",
      run: {
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });
    const queueSettings: QueueSettings = { mode: "queue" };
    enqueueFollowupRun("main", queuedNext, queueSettings);

    const current = createQueuedRun({
      run: {
        verboseLevel: "on",
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });

    await runner(current);

    expect(queuedNext.run.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(queuedNext.run.sessionFile)).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("does not count failed compaction end events in followup runs", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-failed-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (args) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: false },
      });
      return {
        payloads: [{ text: "final" }],
        meta: {
          agentMeta: {
            compactionCount: 0,
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          },
        },
      };
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toBe("final");
    expect(sessionStore.main.compactionCount).toBeUndefined();
  });

  it("injects the post-compaction refresh prompt before followup runs after preflight compaction", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-preflight-followup-"));
    const storePath = path.join(workspaceDir, "sessions.json");
    const transcriptPath = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        message: {
          role: "user",
          content: "x".repeat(320_000),
          timestamp: Date.now(),
        },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Read AGENTS.md before replying.",
        "",
        "## Red Lines",
        "Never skip safety checks.",
      ].join("\n"),
      "utf-8",
    );

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: transcriptPath,
      totalTokens: 10,
      totalTokensFresh: false,
      compactionCount: 1,
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    await saveSessionStore(storePath, sessionStore);

    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 90_000,
        tokensAfter: 8_000,
      },
    });

    const embeddedCalls: Array<{ extraSystemPrompt?: string }> = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: { extraSystemPrompt?: string }) => {
        embeddedCalls.push({ extraSystemPrompt: params.extraSystemPrompt });
        return {
          payloads: [{ text: "final" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 100_000,
    });

    const queued = createQueuedRun({
      run: {
        sessionFile: transcriptPath,
        workspaceDir,
      },
    });

    await runner(queued);

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledOnce();
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Post-compaction context refresh");
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Read AGENTS.md before replying.");

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store.main?.compactionCount).toBe(2);
  });
});

describe("createFollowupRunner bootstrap warning dedupe", () => {
  it("passes stored warning signature history to embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
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
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          allowGatewaySubagentBinding?: boolean;
          bootstrapPromptWarningSignaturesSeen?: string[];
          bootstrapPromptWarningSignature?: string;
        }
      | undefined;
    expect(call?.allowGatewaySubagentBinding).toBe(true);
    expect(call?.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(call?.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }> = {},
  ) {
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
    });
  }

  async function runMessagingCase(params: {
    agentResult: Record<string, unknown>;
    queued?: FollowupRun;
    runnerOverrides?: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }>;
  }) {
    const onBlockReply = createAsyncReplySpy();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...params.agentResult,
    });
    const runner = createMessagingDedupeRunner(onBlockReply, params.runnerOverrides);
    await runner(params.queued ?? baseQueuedRun());
    return { onBlockReply };
  }

  function makeTextReplyDedupeResult(overrides?: Record<string, unknown>) {
    return {
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      ...overrides,
    };
  }

  it("drops payloads already sent via messaging tool", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ text: "hello world!" }],
        messagingToolSentTexts: ["hello world!"],
      },
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: makeTextReplyDedupeResult(),
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses replies when provider is synthetic but originating channel matches", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
      } as FollowupRun,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress replies for same target when account differs", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [
          { tool: "telegram", provider: "telegram", to: "268300329", accountId: "work" },
        ],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "268300329",
        accountId: "personal",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("drops media URL from payload when messaging tool already sent it", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/img.png"],
      },
    });

    // Media stripped → payload becomes non-renderable → not delivered.
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers media payload when not a duplicate", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/other.png"],
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        meta: {
          agentMeta: {
            usage: { input: 1_000, output: 50 },
            lastCallUsage: { input: 400, output: 20 },
            model: "claude-opus-4-5",
            provider: "anthropic",
          },
        },
      },
      runnerOverrides: {
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });

  it("passes queued config into usage persistence during drained followups", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-cfg-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const cfg = {
      messages: {
        responsePrefix: "agent",
      },
    };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          lastCallUsage: { input: 6, output: 3 },
          model: "claude-opus-4-5",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(
      runner(
        createQueuedRun({
          run: {
            config: cfg,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath,
        sessionKey,
        cfg,
      }),
    );
    persistSpy.mockRestore();
  });

  it("does not fall back to dispatcher when cross-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "forced route failure",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("falls back to dispatcher when same-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "outbound adapter unavailable",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun(" Feishu "),
        originatingChannel: "FEISHU",
        originatingTo: "ou_abc123",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world!" }));
  });

  it("routes followups with originating account/thread metadata", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "work",
        threadId: "1739142736.000100",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("createFollowupRunner typing cleanup", () => {
  async function runTypingCase(agentResult: Record<string, unknown>) {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...agentResult,
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());
    return typing;
  }

  function expectTypingCleanup(typing: ReturnType<typeof createMockTypingController>) {
    expect(typing.markRunComplete).toHaveBeenCalled();
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  }

  it("calls both markRunComplete and markDispatchIdle on NO_REPLY", async () => {
    const typing = await runTypingCase({ payloads: [{ text: "NO_REPLY" }] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on empty payloads", async () => {
    const typing = await runTypingCase({ payloads: [] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on agent error", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on successful delivery", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalled();
    expectTypingCleanup(typing);
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockClear();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = createQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as { agentDir?: string };
    expect(call?.agentDir).toBe(agentDir);
  });
});
