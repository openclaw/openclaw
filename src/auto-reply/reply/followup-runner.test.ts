import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

const runEmbeddedPiAgentMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const resolveCommandSecretRefsViaGatewayMock = vi.fn();
const applyMediaUnderstandingMock = vi.fn();
const resolveQueuedReplyExecutionConfigMock = vi.fn();
let resolveQueuedReplyExecutionConfigActual:
  | (typeof import("./agent-runner-utils.js"))["resolveQueuedReplyExecutionConfig"]
  | undefined;
let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;
let clearRuntimeConfigSnapshot: typeof import("../../config/config.js").clearRuntimeConfigSnapshot;
let loadSessionStore: typeof import("../../config/sessions/store.js").loadSessionStore;
let saveSessionStore: typeof import("../../config/sessions/store.js").saveSessionStore;
let clearSessionStoreCacheForTest: typeof import("../../config/sessions/store.js").clearSessionStoreCacheForTest;
let clearFollowupQueue: typeof import("./queue.js").clearFollowupQueue;
let enqueueFollowupRun: typeof import("./queue.js").enqueueFollowupRun;
let sessionRunAccounting: typeof import("./session-run-accounting.js");
let setRuntimeConfigSnapshot: typeof import("../../config/config.js").setRuntimeConfigSnapshot;
let createMockFollowupRun: typeof import("./test-helpers.js").createMockFollowupRun;
let createMockTypingController: typeof import("./test-helpers.js").createMockTypingController;
let buildCollectPrompt: typeof import("../../utils/queue-helpers.js").buildCollectPrompt;
let applyDeferredMediaToQueuedRuns: typeof import("./queue/drain.js").applyDeferredMediaToQueuedRuns;
let buildMediaAwareQueueSummaryPrompt: typeof import("./queue/drain.js").buildMediaAwareQueueSummaryPrompt;
const FOLLOWUP_DEBUG = process.env.OPENCLAW_DEBUG_FOLLOWUP_RUNNER_TEST === "1";
const FOLLOWUP_TEST_QUEUES = new Map<
  string,
  {
    items: FollowupRun[];
    lastRun?: FollowupRun["run"];
  }
>();
const FOLLOWUP_TEST_SESSION_STORES = new Map<string, Record<string, SessionEntry>>();

function debugFollowupTest(message: string): void {
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  process.stderr.write(`[followup-runner.test] ${message}\n`);
}

function registerFollowupTestSessionStore(
  storePath: string,
  sessionStore: Record<string, SessionEntry>,
): void {
  FOLLOWUP_TEST_SESSION_STORES.set(storePath, sessionStore);
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
  nextProvider?: string;
  nextModel?: string;
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
}): void {
  const cleaned = params.key.trim();
  if (!cleaned) {
    return;
  }
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const shouldRewriteSelection =
    typeof params.nextProvider === "string" ||
    typeof params.nextModel === "string" ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource");
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }
  const rewrite = (run?: FollowupRun["run"]) => {
    if (!run) {
      return;
    }
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      if (params.nextSessionFile?.trim()) {
        run.sessionFile = params.nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (typeof params.nextProvider === "string") {
        run.provider = params.nextProvider;
      }
      if (typeof params.nextModel === "string") {
        run.model = params.nextModel;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = params.nextAuthProfileId?.trim() || undefined;
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
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
  const registeredStore = FOLLOWUP_TEST_SESSION_STORES.get(storePath);
  const store = registeredStore ?? loadSessionStore(storePath, { skipCache: true });
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
  if (registeredStore) {
    return;
  }
  await saveSessionStore(storePath, store);
}

async function loadFreshFollowupRunnerModuleForTest() {
  vi.resetModules();
  vi.doUnmock("../../config/config.js");
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
  vi.doMock("./agent-runner-memory.js", () => ({
    runMemoryFlushIfNeeded: async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
    runPreflightCompactionIfNeeded: (...args: unknown[]) =>
      runPreflightCompactionIfNeededMock(...args),
  }));
  vi.doMock("./route-reply.js", () => ({
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  }));
  vi.doMock("./agent-runner-utils.js", async () => {
    const actual =
      await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
    resolveQueuedReplyExecutionConfigActual = actual.resolveQueuedReplyExecutionConfig;
    resolveQueuedReplyExecutionConfigMock.mockImplementation(
      async (...args: Parameters<typeof actual.resolveQueuedReplyExecutionConfig>) =>
        await actual.resolveQueuedReplyExecutionConfig(...args),
    );
    return {
      ...actual,
      resolveQueuedReplyExecutionConfig: (
        ...args: Parameters<typeof actual.resolveQueuedReplyExecutionConfig>
      ) => resolveQueuedReplyExecutionConfigMock(...args),
    };
  });
  vi.doMock("../../cli/command-secret-gateway.js", () => ({
    resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
      resolveCommandSecretRefsViaGatewayMock(...args),
  }));
  vi.doMock("../../cli/command-secret-targets.js", () => ({
    getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries."]),
    getScopedChannelsCommandSecretTargets: ({
      channel,
      accountId,
    }: {
      channel?: string;
      accountId?: string;
    }) => {
      const normalizedChannel = channel?.trim() ?? "";
      if (!normalizedChannel) {
        return { targetIds: new Set<string>() };
      }
      const targetIds = new Set<string>([`channels.${normalizedChannel}.token`]);
      const normalizedAccountId = accountId?.trim() ?? "";
      if (!normalizedAccountId) {
        return { targetIds };
      }
      return {
        targetIds,
        allowedPaths: new Set<string>([
          `channels.${normalizedChannel}.token`,
          `channels.${normalizedChannel}.accounts.${normalizedAccountId}.token`,
        ]),
      };
    },
  }));
  ({ createFollowupRunner } = await import("./followup-runner.js"));
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
    await import("../../config/config.js"));
  ({ clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } =
    await import("../../config/sessions/store.js"));
  ({ clearFollowupQueue, enqueueFollowupRun } = await import("./queue.js"));
  sessionRunAccounting = await import("./session-run-accounting.js");
  ({ createMockFollowupRun, createMockTypingController } = await import("./test-helpers.js"));
  ({ buildCollectPrompt } = await import("../../utils/queue-helpers.js"));
  ({ applyDeferredMediaToQueuedRuns, buildMediaAwareQueueSummaryPrompt } =
    await import("./queue/drain.js"));

  // vi.doMock does not intercept transitive ESM imports in the forks pool, so
  // we use vi.spyOn on the module namespace instead.  ESM live bindings read
  // through the namespace getter, so the spy propagates to followup-media.ts's
  // import of applyMediaUnderstanding.
  const applyMod = await import("../../media-understanding/apply.js");
  vi.spyOn(applyMod, "applyMediaUnderstanding").mockImplementation((...args: unknown[]) =>
    applyMediaUnderstandingMock(...args),
  );
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

beforeAll(async () => {
  await loadFreshFollowupRunnerModuleForTest();
});

beforeEach(() => {
  clearRuntimeConfigSnapshot?.();
  runEmbeddedPiAgentMock.mockReset();
  compactEmbeddedPiSessionMock.mockReset();
  runPreflightCompactionIfNeededMock.mockReset();
  resolveCommandSecretRefsViaGatewayMock.mockReset();
  resolveQueuedReplyExecutionConfigMock.mockReset();
  const resolveQueuedReplyExecutionConfig = resolveQueuedReplyExecutionConfigActual;
  if (!resolveQueuedReplyExecutionConfig) {
    throw new Error("resolveQueuedReplyExecutionConfig mock not initialized");
  }
  resolveQueuedReplyExecutionConfigMock.mockImplementation(
    async (...args: Parameters<typeof resolveQueuedReplyExecutionConfig>) =>
      await resolveQueuedReplyExecutionConfig(...args),
  );
  runPreflightCompactionIfNeededMock.mockImplementation(
    async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
  );
  resolveCommandSecretRefsViaGatewayMock.mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  }));
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
  applyMediaUnderstandingMock.mockReset();
  applyMediaUnderstandingMock.mockResolvedValue({
    outputs: [],
    decisions: [],
    appliedImage: false,
    appliedAudio: false,
    appliedVideo: false,
    appliedFile: false,
  });
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  FOLLOWUP_TEST_SESSION_STORES.clear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot?.();
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  FOLLOWUP_TEST_SESSION_STORES.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
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

const MEDIA_REPLY_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths — they are blocked for security. Keep caption in the text body.";

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & {
    run?: Partial<FollowupRun["run"]>;
  } = {},
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

describe("createFollowupRunner runtime config", () => {
  it("uses the active runtime snapshot for queued embedded followup runs", async () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        run: {
          config: sourceConfig,
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
    );

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          config?: unknown;
        }
      | undefined;
    expect(call?.config).toBe(runtimeConfig);
  });

  it("resolves queued embedded followups before preflight helpers read config", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    resolveCommandSecretRefsViaGatewayMock.mockResolvedValueOnce({
      resolvedConfig: runtimeConfig,
      diagnostics: [],
      targetStatesByPath: { "skills.entries.whisper.apiKey": "resolved_local" },
      hadUnresolvedTargets: false,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    await runner(queued);

    expect(queued.run.config).toBe(runtimeConfig);
    expect(runPreflightCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: runtimeConfig,
      }),
    );
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          config?: unknown;
        }
      | undefined;
    expect(call?.config).toBe(runtimeConfig);
  });

  it("passes queued origin scope into queued execution-config resolution", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const sourceConfig: OpenClawConfig = {};
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingAccountId: "work",
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
        messageProvider: "discord",
        agentAccountId: "bot-account",
      },
    });

    await runner(queued);

    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledWith(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "discord",
      originatingAccountId: "work",
      agentAccountId: "bot-account",
    });
  });
});

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
    registerFollowupTestSessionStore(storePath, sessionStore);

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
    registerFollowupTestSessionStore(storePath, sessionStore);

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
    registerFollowupTestSessionStore(storePath, sessionStore);

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
    registerFollowupTestSessionStore(storePath, sessionStore);

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
    registerFollowupTestSessionStore(storePath, sessionStore);

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
    runPreflightCompactionIfNeededMock.mockImplementationOnce(
      async (params: {
        followupRun: FollowupRun;
        sessionEntry?: SessionEntry;
        sessionStore?: Record<string, SessionEntry>;
        sessionKey?: string;
        storePath?: string;
      }) => {
        await compactEmbeddedPiSessionMock({
          sessionFile: transcriptPath,
          workspaceDir,
        });
        params.followupRun.run.extraSystemPrompt = [
          params.followupRun.run.extraSystemPrompt,
          "Post-compaction context refresh",
          "Read AGENTS.md before replying.",
        ]
          .filter(Boolean)
          .join("\n\n");
        const updatedEntry =
          params.sessionEntry ??
          (params.sessionKey && params.sessionStore
            ? params.sessionStore[params.sessionKey]
            : undefined);
        if (updatedEntry) {
          updatedEntry.compactionCount = 2;
          updatedEntry.updatedAt = Date.now();
          if (params.sessionKey && params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
          if (params.storePath && params.sessionKey) {
            const registeredStore = FOLLOWUP_TEST_SESSION_STORES.get(params.storePath);
            if (registeredStore) {
              registeredStore[params.sessionKey] = updatedEntry;
            } else {
              const store = loadSessionStore(params.storePath, { skipCache: true });
              store[params.sessionKey] = updatedEntry;
              await saveSessionStore(params.storePath, store);
            }
          }
        }
        return updatedEntry;
      },
    );

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
    expect(sessionStore.main?.compactionCount).toBe(2);
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
    if (overrides.storePath && overrides.sessionStore) {
      registerFollowupTestSessionStore(overrides.storePath, overrides.sessionStore);
    }
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
          {
            tool: "telegram",
            provider: "telegram",
            to: "268300329",
            accountId: "work",
          },
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
    const storePath = "/tmp/openclaw-followup-usage.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    persistSpy.mockImplementationOnce(async (params) => {
      const nextEntry: SessionEntry = {
        ...sessionStore[sessionKey],
        updatedAt: Date.now(),
        totalTokens: params.lastCallUsage?.input,
        totalTokensFresh: true,
        model: params.modelUsed,
        modelProvider: params.providerUsed,
        inputTokens: params.usage?.input,
        outputTokens: params.usage?.output,
      };
      sessionStore[sessionKey] = nextEntry;
      Object.assign(sessionEntry, nextEntry);
    });

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
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath,
        sessionKey,
        modelUsed: "claude-opus-4-5",
        providerUsed: "anthropic",
      }),
    );
    expect(sessionStore[sessionKey]?.totalTokens).toBe(400);
    expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(sessionStore[sessionKey]?.inputTokens).toBe(1_000);
    expect(sessionStore[sessionKey]?.outputTokens).toBe(50);
    persistSpy.mockRestore();
  });

  it("passes queued config into usage persistence during drained followups", async () => {
    const storePath = "/tmp/openclaw-followup-usage-cfg.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };

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

  it("uses providerUsed for snapshot freshness when agent metadata overrides the run provider", async () => {
    const storePath = "/tmp/openclaw-followup-usage-provider.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          lastCallUsage: { input: 6, output: 3 },
          model: "claude-opus-4-6",
          provider: "anthropic",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(
      runner(
        createQueuedRun({
          run: {
            provider: "openai",
            config: {
              agents: {
                defaults: {
                  cliBackends: {
                    anthropic: { command: "anthropic" },
                  },
                },
              },
            } as OpenClawConfig,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerUsed: "anthropic",
        usageIsContextSnapshot: true,
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
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      agentDir?: string;
    };
    expect(call?.agentDir).toBe(agentDir);
  });
});

describe("createFollowupRunner media understanding", () => {
  it("applies audio transcription when mediaContext has untranscribed audio", async () => {
    const transcriptText = "Hello, this is a voice note.";
    // The real applyMediaUnderstanding mutates the ctx; the mock must do the same
    // so buildInboundMediaNote and queued prompt rebuilding see the transcribed body.
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Got it!" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
        // MediaUnderstanding is empty — transcription not yet applied
      },
    });
    await runner(queued);

    // applyMediaUnderstanding should have been called
    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    expect(applyMediaUnderstandingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: queued.run.config,
        agentDir: queued.run.agentDir,
      }),
    );

    // The prompt passed to the agent should include the transcript, not the
    // raw audio attachment line.
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("[media attached: /tmp/voice.ogg");

    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "Got it!" }));
  });

  it("propagates the queued message provider into deferred media context", async () => {
    const transcriptText = "Provider-aware transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        expect(params.ctx.Provider).toBe("telegram");
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[User sent media without caption]",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
  });

  it("applies media understanding for URL-only attachments", async () => {
    const transcriptText = "URL-only transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Got it!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: https://cdn.example.com/voice.ogg (audio/ogg)]\nsome text",
        mediaContext: {
          Body: "some text",
          MediaUrl: "https://cdn.example.com/voice.ogg",
          MediaUrls: ["https://cdn.example.com/voice.ogg"],
          MediaType: "audio/ogg",
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
  });

  it("strips the full media line when attachment paths or URLs contain brackets", async () => {
    const transcriptText = "Bracket-safe transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice[0].ogg (audio/ogg) | https://cdn.example.com/files[0].ogg]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/voice[0].ogg"],
          MediaUrls: ["https://cdn.example.com/files[0].ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("[media attached:");
    expect(agentCall?.prompt).not.toContain("files[0].ogg]");
  });

  it("only strips leading synthetic media lines and preserves literal user text later in the prompt", async () => {
    const transcriptText = "Transcript with literal token";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = "I literally typed [media attached: keep me] in this message.";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice.ogg (audio/ogg)]\nI literally typed [media attached: keep me] in this message.",
        mediaContext: {
          Body: "I literally typed [media attached: keep me] in this message.",
          CommandBody: "I literally typed [media attached: keep me] in this message.",
          RawBody: "I literally typed [media attached: keep me] in this message.",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(
      "I literally typed [media attached: keep me] in this message.",
    );
    expect(agentCall?.prompt).not.toContain("[media attached: /tmp/voice.ogg (audio/ogg)]");
  });

  it("skips media understanding when MediaUnderstanding is already populated", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[Audio]\nTranscript:\nAlready transcribed.\n\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
        // MediaUnderstanding already populated — transcription was applied in primary path
        MediaUnderstanding: [
          {
            kind: "audio.transcription",
            text: "Already transcribed.",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ],
      },
    });
    await runner(queued);

    // Should NOT re-run media understanding
    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();

    // The original prompt should be passed through unchanged
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("Already transcribed.");
  });

  it("skips media understanding when no mediaContext is present", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // No mediaContext (plain text message)
    const queued = createQueuedRun({ prompt: "just text" });
    await runner(queued);

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
  });

  it("continues with raw prompt when media understanding fails", async () => {
    applyMediaUnderstandingMock.mockRejectedValueOnce(new Error("transcription service down"));
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const originalPrompt = "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text";
    const queued = createQueuedRun({
      prompt: originalPrompt,
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
      },
    });
    await runner(queued);

    // Should have attempted media understanding
    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);

    // Agent should still run with the original prompt
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toBe(originalPrompt);

    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "fallback reply" }));
  });

  it("rebuilds the prompt when file extraction succeeds without media outputs", async () => {
    const fileBlock = '<file name="notes.txt" mime="text/plain">\nline one\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `some text\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "file processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/notes.txt (text/plain)]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[media attached: /tmp/notes.txt (text/plain)]");
    expect(agentCall?.prompt).toContain(fileBlock);
    expect(agentCall?.prompt?.match(/<file\b/g)).toHaveLength(1);
  });

  it("does not infer file extraction from wrapped Body/RawBody mismatches", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "file processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/report.pdf]\nLine: Alice\nsummarize this",
        mediaContext: {
          Body: "Line: Alice\nsummarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("Line: Alice");
    expect(agentCall?.prompt).toContain(fileBlock);
    expect(agentCall?.prompt?.match(/<file\s+name="report\.pdf"/g)).toHaveLength(1);
  });

  it("preserves non-audio media lines when only audio is transcribed", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        // Simulate transcription updating the context
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "voice transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "voice transcript";
        params.ctx.Body = "[Audio]\nUser text:\nsome text\nTranscript:\nvoice transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "voice transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "got both" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt:
        "[media attached: 2 files]\n[media attached 1/2: /tmp/voice.ogg (audio/ogg)]\n[media attached 2/2: /tmp/photo.jpg (image/jpeg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg", "/tmp/photo.jpg"],
        MediaTypes: ["audio/ogg", "image/jpeg"],
      },
    });
    await runner(queued);

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // Audio attachment line should be stripped
    expect(agentCall?.prompt).not.toContain("voice.ogg");
    // Image attachment line should also be stripped (all media-attached lines are
    // removed and replaced by the new buildInboundMediaNote output)
    // The transcript should be present
    expect(agentCall?.prompt).toContain("voice transcript");
  });

  it("strips queued media lines when attachment paths or URLs contain a literal closing bracket", async () => {
    const transcriptText = "Bracket-safe transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice[0].ogg (audio/ogg) | https://cdn.example.com/files[0].ogg?sig=abc]123]\n" +
          MEDIA_REPLY_HINT +
          "\n" +
          "some text",
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/voice[0].ogg"],
          MediaUrls: ["https://cdn.example.com/files[0].ogg?sig=abc]123"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("/tmp/voice[0].ogg");
    expect(agentCall?.prompt).not.toContain("https://cdn.example.com/files[0].ogg?sig=abc]123");
    expect(agentCall?.prompt).not.toContain(MEDIA_REPLY_HINT);
  });

  it("preserves file-only media understanding when outputs are empty", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body =
          '<file name="report.pdf" mime="application/pdf">\nQuarterly report body\n</file>';
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\n[User sent media without caption]`,
        mediaContext: {
          Body: "",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[media attached: /tmp/report.pdf (application/pdf)]");
    expect(agentCall?.prompt).toContain(MEDIA_REPLY_HINT);
    expect(agentCall?.prompt).toContain('<file name="report.pdf" mime="application/pdf">');
    expect(agentCall?.prompt).toContain("Quarterly report body");
    expect(agentCall?.prompt).not.toContain("[User sent media without caption]");
  });

  it("replaces the queued body when inline directives were already stripped from the prompt", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body =
          '/think high summarize this\n\n<file name="report.pdf" mime="application/pdf">\nreport\n</file>';
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).toContain('<file name="report.pdf" mime="application/pdf">');
    expect(agentCall?.prompt).not.toContain("summarize this\n\n/think high summarize this");
    expect(agentCall?.prompt).not.toContain("/think high summarize this");
  });

  it("preserves directive-like tokens inside extracted media content", async () => {
    const fileBlock =
      '<file name="notes.txt" mime="text/plain">\n/model claude-opus should stay\n/queue followup should stay\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `/think high summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/notes.txt]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).not.toContain("/think high summarize this");
    expect(agentCall?.prompt).toContain("/model claude-opus should stay");
    expect(agentCall?.prompt).toContain("/queue followup should stay");
  });

  it("rebuilds the prompt when image understanding mutates the body without outputs", async () => {
    const description = "[Image]\nDescription:\na mountain at sunset";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = description;
        return {
          outputs: [],
          decisions: [],
          appliedImage: true,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/photo.jpg (image/jpeg)]\nsome text",
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/photo.jpg"],
          MediaTypes: ["image/jpeg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("a mountain at sunset");
  });

  it("does not false-positive on user text containing literal '<file' when extracting files", async () => {
    const fileBlock = '<file name="data.csv" mime="text/csv">\ncol1,col2\n1,2\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `check my <file upload please\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "got it" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // User message contains literal "<file" text but that should NOT prevent
    // file extraction results from being embedded in the prompt.
    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/data.csv (text/csv)]\ncheck my <file upload please",
        mediaContext: {
          Body: "check my <file upload please",
          CommandBody: "check my <file upload please",
          RawBody: "check my <file upload please",
          MediaPaths: ["/tmp/data.csv"],
          MediaTypes: ["text/csv"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // The file extraction result should be present in the prompt
    expect(agentCall?.prompt).toContain(fileBlock);
    expect(agentCall?.prompt).toContain("check my <file upload please");
  });

  it("preserves directive-like text that appears inside extracted file content", async () => {
    const fileBlock =
      '<file name="notes.txt" mime="text/plain">\nRun `/think high` literally in the shell example.\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/notes.txt]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          CommandBody: "summarize this",
          RawBody: "/think high summarize this",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).toContain("Run `/think high` literally in the shell example.");
  });

  it("rebuilds the prompt when image understanding mutates the body alongside existing text", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = "some text\n\n[Image summary]\nA whiteboard with action items.";
        return {
          outputs: [],
          decisions: [],
          appliedImage: true,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/board.jpg (image/jpeg)]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/board.jpg"],
          MediaTypes: ["image/jpeg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[Image summary]");
    expect(agentCall?.prompt).toContain("A whiteboard with action items.");
  });

  it("applies media understanding for URL-only deferred attachments", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = "[Audio]\nTranscript:\nremote transcript";
        params.ctx.Transcript = "remote transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "remote transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[User sent media without caption]",
        mediaContext: {
          Body: "",
          MediaUrl: "https://cdn.example.com/audio.ogg",
          MediaUrls: ["https://cdn.example.com/audio.ogg"],
          MediaType: "audio/ogg",
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("remote transcript");
  });

  it("uses resolved body (CommandBody) as originalBody for accurate prompt replacement", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        // applyMediaUnderstanding mutates the resolved body (which is CommandBody)
        params.ctx.Body = `summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // Body has directive prefix; CommandBody has the cleaned version.
    // The prompt was built from CommandBody, so originalBody should match CommandBody
    // for accurate replacement.
    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          CommandBody: "summarize this",
          RawBody: "/think high summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // File block should be present (extraction succeeded)
    expect(agentCall?.prompt).toContain(fileBlock);
    // The body text should appear once, not duplicated
    expect(agentCall?.prompt).toContain("summarize this");
    // Should NOT contain the directive prefix
    expect(agentCall?.prompt).not.toContain("/think high");
    // The body should not be duplicated (would happen if originalBody didn't match)
    const matches = agentCall?.prompt?.match(/summarize this/g);
    expect(matches?.length).toBe(1);
  });

  it("does not duplicate file blocks for mixed audio+file messages re-processed in followup", async () => {
    const existingFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nold extracted content\n</file>';
    const newFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nnew extracted content\n</file>';
    const transcriptText = "Mixed message transcript";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\nanalyze this\n\n${newFileBlock}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // Simulate a mixed message where the primary path already extracted the
    // PDF (file block is in the prompt) but audio transcription failed.
    await runner(
      createQueuedRun({
        prompt: `[media attached 1/2: /tmp/voice.ogg]\n[media attached 2/2: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nanalyze this\n\n${existingFileBlock}`,
        mediaContext: {
          Body: `analyze this\n\n${existingFileBlock}`,
          CommandBody: "analyze this",
          RawBody: "analyze this",
          MediaPaths: ["/tmp/voice.ogg", "/tmp/report.pdf"],
          MediaTypes: ["audio/ogg", "application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // Should contain the transcript
    expect(agentCall?.prompt).toContain(transcriptText);
    // Should have exactly one file block (the new one), not two
    expect(agentCall?.prompt?.match(/<file\s+name="report\.pdf"/g)).toHaveLength(1);
    expect(agentCall?.prompt).toContain("new extracted content");
    expect(agentCall?.prompt).not.toContain("old extracted content");
  });

  it("preserves unrelated file blocks when the original body is absent from the prompt", async () => {
    const quotedFileBlock =
      '<file name="thread.pdf" mime="application/pdf">\nquoted thread attachment\n</file>';
    const existingFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nold extracted content\n</file>';
    const newFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nnew extracted content\n</file>';
    const transcriptText = "Transcript from deferred audio";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\nsummarize this\n\n${newFileBlock}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached 1/2: /tmp/voice.ogg]\n[media attached 2/2: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nQuoted thread above\n\n${quotedFileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${existingFileBlock}`,
          CommandBody: "summarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/voice.ogg", "/tmp/report.pdf"],
          MediaTypes: ["audio/ogg", "application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("Quoted thread above");
    expect(agentCall?.prompt).toContain(quotedFileBlock);
    expect(agentCall?.prompt).toContain(newFileBlock);
    expect(agentCall?.prompt?.match(/<file\s+name="/g)).toHaveLength(2);
  });

  it("replaces the visible body before file blocks instead of matching file content", async () => {
    const existingFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nsummary notes:\nsummarize this\n</file>';
    const transcriptText = "Transcript from deferred audio";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\nsummarize this`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached 1/2: /tmp/voice.ogg]\n[media attached 2/2: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this\n\n${existingFileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${existingFileBlock}`,
          CommandBody: "summarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/voice.ogg", "/tmp/report.pdf"],
          MediaTypes: ["audio/ogg", "application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    const transcriptBlock = `[Audio]\nTranscript:\n${transcriptText}\n\nsummarize this`;
    expect(agentCall?.prompt).toContain(existingFileBlock);
    expect(agentCall?.prompt).toContain(transcriptBlock);
    expect(agentCall?.prompt?.indexOf(transcriptBlock)).toBeGreaterThan(-1);
    expect(agentCall?.prompt?.indexOf(transcriptBlock)).toBeLessThan(
      agentCall?.prompt?.indexOf(existingFileBlock) ?? -1,
    );
  });

  it("finds the body after thread-history file blocks when body appears after the first <file> tag", async () => {
    const threadFileBlock =
      '<file name="thread.pdf" mime="application/pdf">\nolder thread attachment\n</file>';
    const transcriptText = "Transcript from deferred voice note";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\ncheck this out`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // The prompt has thread history with a file block BEFORE the current
    // queued body text.  The old truncation approach would miss the body
    // because it only searched before the first <file> tag.
    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/voice.ogg]\n${MEDIA_REPLY_HINT}\nThread history\n\n${threadFileBlock}\n\ncheck this out`,
        mediaContext: {
          Body: "check this out",
          RawBody: "check this out",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    const transcriptBlock = `[Audio]\nTranscript:\n${transcriptText}\n\ncheck this out`;
    // The body should be replaced with the transcript block
    expect(agentCall?.prompt).toContain(transcriptBlock);
    // Thread history and its file block should be preserved
    expect(agentCall?.prompt).toContain("Thread history");
    expect(agentCall?.prompt).toContain(threadFileBlock);
  });

  it("sets DeferredMediaApplied when media understanding throws", async () => {
    applyMediaUnderstandingMock.mockRejectedValueOnce(
      new Error("transcription service unavailable"),
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback reply" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
      },
    });

    await runner(queued);

    // DeferredMediaApplied should be set so re-runs don't retry
    expect(queued.mediaContext?.DeferredMediaApplied).toBe(true);

    // The agent should still be called with the raw prompt
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("some text");
  });

  it("does not re-apply file extraction when the stored media body already has a file block", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this\n\n${fileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${fileBlock}`,
          CommandBody: "summarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt?.match(/<file\s+name="report\.pdf"/g)).toHaveLength(1);
  });

  it("does not re-apply file extraction when RawBody is missing but Body already has a matching file block", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this\n\n${fileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${fileBlock}`,
          CommandBody: "summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(fileBlock);
  });

  it("treats any stored file block as already extracted even when the filename differs from the attachment basename", async () => {
    const fileBlock =
      '<file name="statement-from-mail.pdf" mime="application/pdf">\nreport content\n</file>';
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: `[media attached: /tmp/upload-8472.bin]\n${MEDIA_REPLY_HINT}\nsummarize this\n\n${fileBlock}`,
      mediaContext: {
        Body: `summarize this\n\n${fileBlock}`,
        CommandBody: "summarize this",
        MediaPaths: ["/tmp/upload-8472.bin"],
        MediaTypes: ["application/pdf"],
      },
    });

    await runner(queued);

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
    expect(queued.mediaContext?.DeferredFileBlocksExtracted).toBe(true);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt?.match(/<file\s+name="statement-from-mail\.pdf"/g)).toHaveLength(1);
  });

  it("replaces the trailing repeated body segment instead of the first matching thread text", async () => {
    const existingFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nold extracted content\n</file>';
    const newFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nnew extracted content\n</file>';
    const transcriptText = "Deferred transcript";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\nsummarize this\n\n${newFileBlock}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          `[media attached 1/2: /tmp/voice.ogg]\n[media attached 2/2: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nThread history: summarize this\n\n` +
          `summarize this\n\n${existingFileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${existingFileBlock}`,
          CommandBody: "summarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/voice.ogg", "/tmp/report.pdf"],
          MediaTypes: ["audio/ogg", "application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("Thread history: summarize this");
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).toContain(newFileBlock);
    expect(agentCall?.prompt).not.toContain("old extracted content");
    expect(agentCall?.prompt?.indexOf(newFileBlock)).toBeGreaterThan(
      agentCall?.prompt?.lastIndexOf("summarize this") ?? -1,
    );
  });
});

describe("followup queue drain deferred media understanding", () => {
  it("preprocesses collect batches before synthesizing the followup prompt", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "collect transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "collect transcript";
        params.ctx.Body = "[Audio]\nTranscript:\ncollect transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "collect transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    const items: FollowupRun[] = [
      createQueuedRun({
        prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
        summaryLine: "some text",
        originatingChannel: "telegram",
        originatingTo: "chat:1",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
      createQueuedRun({
        prompt: "second text",
        summaryLine: "second text",
        originatingChannel: "telegram",
        originatingTo: "chat:1",
        run: { messageProvider: "telegram" },
      }),
    ];

    await applyDeferredMediaToQueuedRuns(items);

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
    });

    expect(prompt).toContain("collect transcript");
    expect(prompt).toContain("Queued #2\nsecond text");
    expect(prompt).not.toContain("[media attached: /tmp/voice.ogg");
  });

  it("preprocesses queued runs in parallel", async () => {
    const resolvers: Array<() => void> = [];
    const done = () => ({
      outputs: [],
      decisions: [],
      appliedImage: false,
      appliedAudio: false,
      appliedVideo: false,
      appliedFile: false,
    });
    applyMediaUnderstandingMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          resolvers.push(() => resolve(done()));
        }),
    );

    const items: FollowupRun[] = [
      createQueuedRun({
        prompt: "[media attached: /tmp/voice-1.ogg (audio/ogg)]\nfirst text",
        summaryLine: "first text",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "first text",
          MediaPaths: ["/tmp/voice-1.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
      createQueuedRun({
        prompt: "[media attached: /tmp/voice-2.ogg (audio/ogg)]\nsecond text",
        summaryLine: "second text",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "second text",
          MediaPaths: ["/tmp/voice-2.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    ];

    const pending = applyDeferredMediaToQueuedRuns(items);

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(2);

    for (const resolve of resolvers) {
      resolve();
    }
    await pending;
  });

  it("preprocesses dropped media items before building overflow summaries", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "overflow transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "overflow transcript";
        params.ctx.Body = "[Audio]\nTranscript:\noverflow transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "overflow transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    const summaryPrompt = await buildMediaAwareQueueSummaryPrompt({
      dropPolicy: "summarize",
      droppedCount: 1,
      summaryLines: ["[media attached: /tmp/voice.ogg (audio/ogg)]"],
      summaryItems: [
        createQueuedRun({
          prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]",
          summaryLine: "",
          run: { messageProvider: "telegram" },
          mediaContext: {
            Body: "",
            MediaPaths: ["/tmp/voice.ogg"],
            MediaTypes: ["audio/ogg"],
          },
        }),
      ],
      noun: "message",
    });

    expect(summaryPrompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(summaryPrompt).toContain("overflow transcript");
    expect(summaryPrompt).not.toContain("[media attached: /tmp/voice.ogg");
  });
});
