// Tests agent runner memory flush and persisted memory context handling.
import fsCore from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  createAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import { withSessionCompactionPersistenceAsync } from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { ZERO_USAGE_FIXTURE } from "../../agents/test-helpers/usage-fixtures.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  readTranscriptStatsSync,
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { readActiveTranscriptStats } from "../../config/sessions/session-accessor.sqlite-history.test-support.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import * as transcriptAccounting from "../../config/sessions/session-transcript-accounting.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  runMemoryFlushIfNeeded as runMemoryFlushIfNeededRaw,
  runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw,
} from "./agent-runner-memory.js";
import {
  createMemoryFlushPlan,
  createModifiedMemoryFlushPlan,
  createMemoryRunEntryMockImplementation,
  seedMemoryAccountingTranscript,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentParams,
  type ModelFallbackParams,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";
import { createMockReplyOperation } from "./test-helpers.js";

const {
  compactEmbeddedAgentSessionMock,
  runEmbeddedAgentEntryMock,
  runEmbeddedAgentMock,
  refreshQueuedFollowupSessionMock,
  incrementCompactionCountMock,
  registerAgentRunContextMock,
  clearAgentRunContextMock,
} = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
  runEmbeddedAgentEntryMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
  refreshQueuedFollowupSessionMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
}));
const runWithModelFallbackMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEmbeddedAgentEntryMock,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
}));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: incrementCompactionCountMock,
}));
vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  registerAgentRunContext: registerAgentRunContextMock,
  clearAgentRunContext: clearAgentRunContextMock,
}));

let incrementCompactionCount: typeof import("./session-updates.js").incrementCompactionCount;
beforeAll(async () => {
  ({ incrementCompactionCount } =
    await vi.importActual<typeof import("./session-updates.js")>("./session-updates.js"));
});

const TEST_MAX_FLUSH_FAILURES = 3;

type MemoryFlushTestParams = Parameters<typeof runMemoryFlushIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runMemoryFlushIfNeeded(params: MemoryFlushTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runMemoryFlushIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({ ...runParams, contextTokens: modelContextTokens }),
  });
}

type PreflightCompactionTestParams = Parameters<typeof runSessionCompactionIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runSessionCompactionIfNeeded(params: PreflightCompactionTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runSessionCompactionIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({ ...runParams, contextTokens: modelContextTokens }),
  });
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createFreshSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return createSessionEntry({ totalTokensFresh: true, totalTokensVersion: 1, ...overrides });
}

function createFlushSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return createFreshSessionEntry({ totalTokens: 80_000, compactionCount: 1, ...overrides });
}

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

function registerClaudeCliBackend(ownsNativeCompaction = false): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        ownsNativeCompaction,
      },
    ],
  });
}

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
  updateSessionId: ReturnType<typeof vi.fn<ReplyOperation["updateSessionId"]>>;
};

function createReplyOperation(): TestReplyOperation {
  const { replyOperation } = createMockReplyOperation({ key: "test" });
  return Object.assign(replyOperation, {
    phase: "queued" as const,
    setPhase: vi.fn<ReplyOperation["setPhase"]>(),
    updateSessionId: vi.fn<ReplyOperation["updateSessionId"]>(),
  });
}

function createCompactionLifecycle(replyOperation: ReplyOperation) {
  return {
    abortSignal: replyOperation.abortSignal,
    onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
    onSessionIdChanged: (sessionId: string) => replyOperation.updateSessionId(sessionId),
  };
}

function loadMainSessionEntry(storePath: string): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey: "main" });
  if (!entry) {
    throw new Error("expected persisted main session entry");
  }
  return entry;
}

function usageEvent(
  content: string,
  usage: Partial<ReturnType<typeof makeAssistantMessageFixture>["usage"]>,
  api?: string,
) {
  return {
    type: "message",
    message: { role: "assistant", content, usage, ...(api ? { api } : {}) },
  };
}

function compactionConfig(compaction: AgentDefaultsConfig["compaction"]) {
  return { agents: { defaults: { compaction } } };
}

function modelRoutingProvenance(
  requestedProvider: string,
  requestedModel: string,
  stage: ModelFallbackAttemptProvenance["stage"] = "initial",
): ModelFallbackAttemptProvenance {
  return { requestedProvider, requestedModel, stage };
}

function requireModelFallbackCall(index = 0) {
  const call = runWithModelFallbackMock.mock.calls[index]?.[0] as ModelFallbackParams | undefined;
  if (!call) {
    throw new Error(`runWithModelFallback call ${index} missing`);
  }
  return call;
}

function requireCompactEmbeddedAgentSessionCall(index = 0) {
  const call = compactEmbeddedAgentSessionMock.mock.calls[index]?.[0] as
    | CompactEmbeddedAgentSessionParams
    | undefined;
  if (!call) {
    throw new Error(`compactEmbeddedAgentSession call ${index} missing`);
  }
  return call;
}

describe("runMemoryFlushIfNeeded", () => {
  let suiteRoot = "";
  let caseCount = 0;
  let rootDir = "";

  function sessionScope(sessionKey = "main", fileName = "sessions.json") {
    return {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      storePath: path.join(rootDir, fileName),
    };
  }

  async function writeTranscript(
    events: Parameters<typeof replaceTranscriptEvents>[1],
    sessionKey = "main",
  ) {
    const scope = sessionScope(sessionKey);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await replaceTranscriptEvents(scope, events);
    await waitForSessionTranscriptProjection(scope);
  }

  async function runDefaultMemoryFlush(
    sessionEntry: SessionEntry,
    overrides: Partial<MemoryFlushTestParams> = {},
  ) {
    const sessionKey = overrides.sessionKey ?? "main";
    return await runMemoryFlushIfNeeded({
      cfg: compactionConfig({ memoryFlush: {} }),
      followupRun: createTestFollowupRun(),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      ...overrides,
    });
  }

  async function runDefaultPreflight(
    sessionEntry: SessionEntry | undefined,
    overrides: Partial<PreflightCompactionTestParams> = {},
  ) {
    const sessionKey = overrides.sessionKey ?? "main";
    return await runSessionCompactionIfNeeded({
      cfg: compactionConfig({ memoryFlush: {} }),
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: sessionEntry ? { [sessionKey]: sessionEntry } : undefined,
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
      ...overrides,
    });
  }

  function runCodexBytePreflight(
    entry: SessionEntry | undefined,
    overrides: Partial<PreflightCompactionTestParams> = {},
  ) {
    return runDefaultPreflight(entry, {
      cfg: compactionConfig({ maxActiveTranscriptBytes: "10b" }),
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: overrides.sessionKey ?? "main",
      }),
      defaultModel: "gpt-5.5",
      modelContextTokens: 1_000_000,
      ...overrides,
    });
  }

  async function createRequiredPreflight(
    entryOverrides: Partial<SessionEntry> = {},
    sessionKey = "agent:main:main",
  ) {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    const sessionEntry = createFreshSessionEntry({ totalTokens: 120, ...entryOverrides });
    return {
      sessionEntry,
      run: (overrides: Partial<PreflightCompactionTestParams> = {}) =>
        runDefaultPreflight(sessionEntry, {
          modelContextTokens: 100,
          sessionKey,
          ...overrides,
        }),
    };
  }

  async function createOversizedByteCompactionFixture() {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    await writeTranscript([
      { type: "message", message: { role: "user", content: "x".repeat(256) } },
    ]);
    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
    });
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, sessionEntry);
    const run = async (entry: SessionEntry, maxActiveTranscriptBytes = "10b") =>
      await runDefaultPreflight(entry, {
        cfg: compactionConfig({ maxActiveTranscriptBytes }),
      });
    return { run, sessionEntry, storePath };
  }

  beforeAll(async () => {
    // openclaw-temp-dir: allow removal must await the agent database drain below
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
  });

  afterAll(async () => {
    // Session writes leave deferred maintenance and history Workers on each case's agent
    // database; an open during removal recreates files and fails rmdir with ENOTEMPTY.
    // One suite-level drain avoids paying Worker shutdown in every case.
    await closeOpenClawAgentDatabasesAsync(suiteRoot);
    await fs.rm(suiteRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rootDir = path.join(suiteRoot, `case-${++caseCount}`);
    await fs.mkdir(rootDir);
    registerMemoryFlushPlanResolverForTest(createMemoryFlushPlan);
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model, {
        modelRoutingProvenance: modelRoutingProvenance(provider, model),
      }),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedAgentEntryMock.mockReset().mockImplementation(
      createMemoryRunEntryMockImplementation({
        runWithModelFallback: runWithModelFallbackMock,
        ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginMock,
      }),
    );
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
    ensureSelectedAgentHarnessPluginMock.mockReset().mockResolvedValue(undefined);
    registerAgentRunContextMock.mockReset();
    clearAgentRunContextMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + Math.max(0, params.amount ?? 1),
        transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
      };
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeTestSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
  });

  it("reuses its private buffer and admitted lifecycle across a model fallback", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = createFlushSessionEntry({ lifecycleRevision: "memory-generation" });
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    const primaryError = new Error("primary failed after private compaction");
    let memorySession: SessionManager | undefined;
    let admission: PreparedAgentRunAdmission | undefined;
    let admittedContext: AdmittedRunContext | undefined;
    const releaseOperatorAuthority = vi.fn();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: vi.fn(),
      retain: () => releaseOperatorAuthority,
    });
    runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        admission = params.preparedRunAdmission;
        memorySession = params.sessionManager;
        if (!admission || !memorySession) {
          throw new Error("Missing private memory runtime");
        }
        expect(memorySession.getSessionTarget()).toBeUndefined();
        admittedContext = await admission.admit("embedded");
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        expect(readAdmittedRunOperatorAuthority(admittedContext)).toMatchObject({
          profileId: "guest",
          scopes: ["operator.write"],
        });
        const retained = memorySession.appendMessage(makeUserMessage("Private retained work", 1));
        memorySession.appendCompaction("Private summary", retained, 120);
        throw primaryError;
      })
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        if (!memorySession || !admission || !admittedContext) {
          throw new Error("Missing first memory attempt");
        }
        expect(params.sessionManager).toBe(memorySession);
        expect(params.preparedRunAdmission).toBe(admission);
        expect(await admission.admit("embedded")).toBe(admittedContext);
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        expect(memorySession.getBranch().at(-1)).toMatchObject({
          type: "compaction",
          summary: "Private summary",
        });
        expect(loadMainSessionEntry(storePath).compactionCount).toBe(1);
        return { payloads: [], meta: {} };
      });
    runWithModelFallbackMock.mockImplementationOnce(async (params: ModelFallbackParams) => {
      await expect(
        params.run("anthropic", "claude", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude"),
        }),
      ).rejects.toBe(primaryError);
      return {
        result: await params.run("anthropic", "fallback", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude", "fallback"),
        }),
        provider: "anthropic",
        model: "fallback",
        attempts: [],
      };
    });
    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: {
        ...createTestFollowupRun({
          thinkingCatalog: [
            { provider: "anthropic", id: "claude", input: ["text"] },
            { provider: "anthropic", id: "fallback", input: ["text"] },
          ],
        }),
        operatorAuthority,
      },
      sessionStore,
      sessionKey,
      storePath,
    });
    expect(result.outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
    expect(loadMainSessionEntry(storePath)).toMatchObject({
      sessionId: "session",
      lifecycleRevision: "memory-generation",
      compactionCount: 1,
      memoryFlush: { kind: "succeeded", compactionCount: 1 },
    });
    if (!admittedContext) {
      throw new Error("Memory attempt was not admitted");
    }
    expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeUndefined();
    expect(releaseOperatorAuthority).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "bounded tail", customTail: 512, newUser: false, tainted: true },
    { label: "new user boundary", customTail: 0, newUser: true, tainted: false },
    {
      label: "non-owner requester",
      customTail: 0,
      newUser: true,
      tainted: true,
      senderIsOwner: false,
    },
  ])(
    "accounts for usage and owner-turn taint independently across $label",
    async ({ customTail, newUser, tainted, senderIsOwner = true }) => {
      const scope = sessionScope("agent:main:main", "tainted-owner-session.json");
      const { sessionKey, storePath } = scope;
      await seedMemoryAccountingTranscript(scope, rootDir, { customTail, newUser });
      const sessionEntry = createFlushSessionEntry({ totalTokensFresh: customTail > 0 });
      const hostAccounting = vi.spyOn(
        transcriptAccounting,
        "readSessionTranscriptAccountingFromProjection",
      );
      onTestFinished(() => {
        hostAccounting.mockRestore();
      });

      await runDefaultMemoryFlush(sessionEntry, {
        followupRun: createTestFollowupRun({
          workspaceDir: rootDir,
          sessionId: "session",
          sessionKey,
          senderIsOwner,
        }),
        sessionKey,
        storePath,
      });

      expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialTurnTainted: tainted }),
      );
      expect(hostAccounting).not.toHaveBeenCalled();
      if (customTail === 0) {
        expect(loadSessionEntry({ sessionKey, storePath })?.totalTokens).toBeGreaterThanOrEqual(
          78_000,
        );
      }
    },
  );

  it("counts resolved error payloads as failed memory flushes", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      return {
        payloads: [
          { text: "normal silent maintenance reply" },
          {
            text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
            isError: true,
          },
        ],
        meta: {},
      };
    });
    const followupRun = createTestFollowupRun();

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun,
      sessionStore,
      storePath,
    });

    expect(requireModelFallbackCall().userLockedAuthProfileId).toBeUndefined();
    expect(result.outcome).toBe("failed");
    expect(registerAgentRunContextMock).toHaveBeenCalledOnce();
    expect(clearAgentRunContextMock).toHaveBeenCalledOnce();
    expect(clearAgentRunContextMock).toHaveBeenCalledWith(
      registerAgentRunContextMock.mock.calls[0]?.[0],
    );
    expect(result.sessionEntry?.sessionId).toBe("session");
    expect(followupRun.run.sessionId).toBe("session");
    const persisted = loadMainSessionEntry(storePath);
    expect(persisted.sessionId).toBe("session");
    expect(persisted.compactionCount).toBe(1);
    expect(persisted.memoryFlush).toEqual({ kind: "failed", failureCount: 1 });
  });

  it("does not increment memory-flush failures for user aborts (regression: #80755)", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const abortErr = new Error("operation aborted by user");
    abortErr.name = "AbortError";
    runWithModelFallbackMock.mockRejectedValueOnce(abortErr);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
    });

    expect(result.outcome).toBe("failed");
    expect(loadMainSessionEntry(storePath).memoryFlush).toBeUndefined();
  });

  it.each<{
    stage: string;
    setup: (error: Error) => void | (() => void);
  }>([
    {
      stage: "initial plan resolution",
      setup: (error: Error) => {
        const resolver = vi
          .fn<MemoryFlushPlanResolver>()
          .mockImplementationOnce(() => {
            throw error;
          })
          .mockImplementation(createMemoryFlushPlan);
        registerMemoryFlushPlanResolverForTest(resolver);
      },
    },
    {
      stage: "target preparation",
      setup: (error: Error) => {
        const originalOpen = fsCore.promises.open.bind(fsCore.promises);
        const targetPath = path.join(rootDir, "memory/2023-11-14.md");
        const openSpy = vi
          .spyOn(fsCore.promises, "open")
          .mockImplementation(async (target, flags, mode) => {
            if (target === targetPath) {
              openSpy.mockRestore();
              throw error;
            }
            return await originalOpen(target, flags, mode);
          });
        return () => openSpy.mockRestore();
      },
    },
  ])("records a failed $stage attempt, cleans up, and retries", async (failure) => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const message = `${failure.stage} failed`;
    const error = new Error(message);
    const cleanup = failure.setup(error);
    const overrides: Partial<MemoryFlushTestParams> = {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      sessionStore,
      storePath,
    };

    try {
      const result = await runDefaultMemoryFlush(sessionEntry, overrides);

      expect(result.outcome).toBe("failed");
      expect(sessionStore.main.memoryFlush).toEqual({ kind: "failed", failureCount: 1 });
      const persistedFailure = loadMainSessionEntry(storePath);
      expect(persistedFailure.memoryFlush).toEqual({
        kind: "failed",
        failureCount: 1,
      });
      expect(result.sessionEntry).toEqual(persistedFailure);
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(registerAgentRunContextMock).not.toHaveBeenCalled();
      expect(clearAgentRunContextMock).not.toHaveBeenCalled();
      const retry = await runDefaultMemoryFlush(persistedFailure, overrides);

      expect(retry.outcome).toBe("completed");
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(registerAgentRunContextMock).toHaveBeenCalledTimes(1);
      expect(clearAgentRunContextMock).toHaveBeenCalledTimes(1);
      expect(loadMainSessionEntry(storePath).memoryFlush).toEqual({
        kind: "succeeded",
        compactionCount: 1,
      });
    } finally {
      if (cleanup) {
        cleanup();
      }
    }
  });

  it("honors a time-refreshed null plan before preparing or registering a run", async () => {
    const resolver = vi
      .fn<MemoryFlushPlanResolver>()
      .mockImplementationOnce(createMemoryFlushPlan)
      .mockReturnValueOnce(null);
    registerMemoryFlushPlanResolverForTest(resolver);
    const sessionEntry = createFlushSessionEntry();

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      defaultModel: "anthropic/claude-opus-4-7",
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(registerAgentRunContextMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentEntryMock).not.toHaveBeenCalled();
  });

  it("marks flush as completed after MAX_FLUSH_FAILURES to break retry loop", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry({
      memoryFlush: { kind: "failed", failureCount: TEST_MAX_FLUSH_FAILURES - 1 },
    });
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider crashed during flush"));

    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
    });

    const persisted = loadMainSessionEntry(storePath);
    expect(result.outcome).toBe("exhausted");
    expect(persisted.memoryFlush).toEqual({ kind: "succeeded", compactionCount: 1 });
  });

  it("skips memory flush for incognito sessions", async () => {
    const sessionEntry = createFlushSessionEntry({
      incognito: true,
      sessionId: "incognito-session",
    });

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("skips memory flush for an incognito key after process-local state is gone", async () => {
    const sessionKey = "agent:main:dashboard:incognito-deleted-memory";
    const sessionEntry = createFlushSessionEntry({
      sessionId: "rematerialized-session",
    });

    const result = await runDefaultMemoryFlush(sessionEntry, {
      sessionKey,
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("uses the policy owner's memory-flush writability for agent:other:main", async () => {
    const { agentId, sessionKey, runtimePolicySessionKey } = {
      agentId: "other",
      sessionKey: "agent:other:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
    };

    const sessionEntry = createFlushSessionEntry();

    const result = await runDefaultMemoryFlush(sessionEntry, {
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, other: { sandbox: { workspaceAccess: "rw" } } },
          defaults: {
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceAccess: "ro",
            },
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        agentId,
        sessionKey,
        runtimePolicySessionKey,
      }),
      sessionKey,
      runtimePolicySessionKey,
      storePath: undefined,
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips memory flush when a persisted sandbox requirement caps workspace access", async () => {
    const sessionKey = "agent:main:guest";
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionEntry = createFlushSessionEntry({ sandbox: "required" });
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      cfg: {
        session: { store: storePath },
        agents: {
          defaults: {
            sandbox: { mode: "off", workspaceAccess: "rw" },
            compaction: { memoryFlush: {} },
          },
        },
      },
      followupRun: createTestFollowupRun({ sessionKey, workspaceDir: rootDir }),
      sessionKey,
      storePath,
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues when preflight compaction reports the session is already under target", async () => {
    const { sessionEntry, run } = await createRequiredPreflight({
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    });
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already under target",
    });
    const onCompactionNotice = vi.fn();

    const entry = await run({ onCompactionNotice });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      trigger: "budget",
      force: true,
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "tokens",
      deferOwningContextEngineCompaction: false,
      contextTokenBudget: 100,
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    });
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "skipped");

    onCompactionNotice.mockClear();
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no real conversation messages",
    });
    await expect(run({ onCompactionNotice })).rejects.toThrow(
      "Preflight compaction required but failed: no real conversation messages",
    );
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "incomplete");
  });

  it("passes persisted session policy and runtime policy key to preflight compaction", async () => {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = createFreshSessionEntry({
      totalTokens: 120,
      permissionMode: "full",
      sessionRoot: "/tmp/workspace",
    });

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionKey: "agent:main:main",
        cwd: "/tmp/task-repo",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      modelContextTokens: 100,
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionKey).toBe("agent:main:main");
    expect(compactCall.cwd).toBe("/tmp/task-repo");
    expect(compactCall.sandboxSessionKey).toBe("agent:main:telegram:default:direct:12345");
    expect(compactCall.sessionEntry).toBe(sessionEntry);
  });

  it("applies session compaction at reported pressure after a runtime fallback with memory flush disabled", async () => {
    // A disabled memory plugin supplies no flush plan; compaction still owns its budget.
    registerMemoryFlushPlanResolverForTest(() => null);
    const sessionEntry = createFlushSessionEntry({
      totalTokens: 904_869,
      compactionCount: 0,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      lifecycleRevision: "owned-generation",
    });
    const overrides: Partial<PreflightCompactionTestParams> = {
      cfg: {
        agents: {
          defaults: { compaction: { mode: "safeguard", memoryFlush: { enabled: false } } },
        },
        tools: { deny: ["*"] },
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "codex" },
              baseUrl: "https://chatgpt.com/backend-api",
              api: "openai-chatgpt-responses",
              models: [
                {
                  id: "gpt-5.6-luna",
                  name: "Context budget test",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_050_000,
                  contextTokens: 922_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.6-luna",
        workspaceDir: rootDir,
        agentDir: rootDir,
      }),
      defaultModel: "openai/gpt-5.6-luna",
      modelContextTokens: 922_000,
      promptForEstimate: "",
      authorize: () => true,
      agentHarnessId: "openclaw",
    };

    const flush = await runDefaultMemoryFlush(sessionEntry, overrides);
    expect(flush.outcome).toBe("skipped");
    await runDefaultPreflight(sessionEntry, overrides);

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      agentHarnessId: "openclaw",
      contextTokenBudget: 922_000,
      currentTokenCount: 904_869,
      force: true,
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "tokens",
    });
    expect(incrementCompactionCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSession: expect.objectContaining({
          sessionId: "session",
          lifecycleRevision: "owned-generation",
        }),
      }),
    );
  });

  it("awaits one pre-compaction checkpoint and compacts the refreshed session", async () => {
    const sessionEntry = createFlushSessionEntry({ totalTokens: 90_000 });
    const refreshedEntry = { ...sessionEntry, sessionId: "checkpoint-successor" };
    const entered = createDeferred();
    const release = createDeferred();
    const events: string[] = [];
    const beforeCompaction = vi.fn(async (entry: SessionEntry) => {
      expect(entry.sessionId).toBe("session");
      events.push("checkpoint started");
      entered.resolve();
      await release.promise;
      events.push("checkpoint completed");
      return refreshedEntry;
    });
    compactEmbeddedAgentSessionMock.mockImplementationOnce(async () => {
      events.push("compactor started");
      return { ok: true, compacted: true, result: { tokensAfter: 42 } };
    });
    const pending = runDefaultPreflight(sessionEntry, { beforeCompaction });
    try {
      await expect(
        Promise.race([
          entered.promise.then(() => "checkpoint"),
          pending.then(() => "returned before checkpoint"),
        ]),
      ).resolves.toBe("checkpoint");
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      release.resolve();
      await pending;

      expect(beforeCompaction).toHaveBeenCalledOnce();
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
      expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
        sessionId: "checkpoint-successor",
        preflightRequired: true,
      });
      expect(events).toEqual(["checkpoint started", "checkpoint completed", "compactor started"]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("skips compaction when the checkpoint returns a session below hard pressure", async () => {
    const sessionEntry = createFlushSessionEntry({ totalTokens: 90_000 });
    const refreshedEntry = { ...sessionEntry, totalTokens: 10_000 };
    const beforeCompaction = vi.fn(async () => refreshedEntry);

    const result = await runDefaultPreflight(sessionEntry, { beforeCompaction });

    expect(beforeCompaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ sessionId: "session", totalTokens: 10_000 });
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("does not compact after cancellation during the pre-compaction checkpoint", async () => {
    const sessionEntry = createFlushSessionEntry({ totalTokens: 90_000 });
    const controller = new AbortController();
    const entered = createDeferred();
    const release = createDeferred();
    const beforeCompaction = vi.fn(async (entry: SessionEntry) => {
      entered.resolve();
      await release.promise;
      return entry;
    });
    const pending = runDefaultPreflight(sessionEntry, {
      beforeCompaction,
      abortSignal: controller.signal,
    });
    try {
      await expect(
        Promise.race([
          entered.promise.then(() => "checkpoint"),
          pending.then(() => "returned before checkpoint"),
        ]),
      ).resolves.toBe("checkpoint");
      controller.abort(new Error("cancelled during checkpoint"));
      const rejection = expect(pending).rejects.toThrow("cancelled during checkpoint");
      release.resolve();
      await rejection;

      expect(beforeCompaction).toHaveBeenCalledOnce();
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it.each([
    { stage: "before start", invalidation: "authorization" },
    { stage: "after start notice", invalidation: "authorization" },
    { stage: "after awaited compactor", invalidation: "authorization" },
    { stage: "after awaited compactor", invalidation: "abort" },
    { stage: "after awaited compactor", invalidation: "operator" },
  ] as const)(
    "rejects $invalidation invalidation $stage without accounting or adopting compaction",
    async ({ stage, invalidation }) => {
      const sessionEntry = createFlushSessionEntry();
      const sessionStore = { main: sessionEntry };
      const followupRun = createTestFollowupRun({ workspaceDir: rootDir });
      const controller = new AbortController();
      let authorized = true;
      let operatorCurrent = true;
      if (invalidation === "operator") {
        followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "guest",
          scopes: ["operator.write"],
          assertCurrent: () => {
            if (!operatorCurrent) {
              throw new Error("operator authority revoked");
            }
          },
        });
      }
      const invalidate = () => {
        if (invalidation === "authorization") {
          authorized = false;
        } else if (invalidation === "operator") {
          operatorCurrent = false;
        } else {
          controller.abort(new Error("caller aborted"));
        }
      };
      const compactorStarted = createDeferred();
      const releaseCompactor = createDeferred();
      compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
        compactorStarted.resolve();
        await releaseCompactor.promise;
        host?.assertActive?.();
        return { ok: true, compacted: true, result: { tokensAfter: 42, sessionId: "successor" } };
      });
      const onCompactionStart = vi.fn();
      const onSessionIdChanged = vi.fn();
      const onCompactionNotice = vi.fn(async (phase: string) => {
        if (stage === "after start notice" && phase === "start") {
          invalidate();
        }
      });
      if (stage === "before start") {
        invalidate();
      }
      if (stage !== "after awaited compactor") {
        releaseCompactor.resolve();
      }

      const pending = runDefaultPreflight(sessionEntry, {
        followupRun,
        sessionStore,
        abortSignal: controller.signal,
        authorize: () => authorized,
        onCompactionStart,
        onSessionIdChanged,
        onCompactionNotice,
      });
      if (stage === "after awaited compactor") {
        await compactorStarted.promise;
        invalidate();
        releaseCompactor.resolve();
      }
      await expect(pending).rejects.toThrow(
        invalidation === "authorization"
          ? "Session compaction maintenance is no longer active"
          : invalidation === "abort"
            ? "caller aborted"
            : "operator authority revoked",
      );

      expect(onCompactionStart).toHaveBeenCalledTimes(stage === "before start" ? 0 : 1);
      if (stage === "before start") {
        expect(onCompactionNotice).not.toHaveBeenCalled();
      }
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(
        stage === "after awaited compactor" ? 1 : 0,
      );
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
      expect(onSessionIdChanged).not.toHaveBeenCalled();
      expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
      expect(sessionStore.main).toBe(sessionEntry);
      expect(followupRun.run.sessionId).toBe("session");
    },
  );

  it("ignores unversioned fresh state and legacy CLI usage on the first upgraded turn", async () => {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "sessions.json");
    const legacyCli = usageEvent(
      "legacy cumulative turn",
      { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      "cli",
    );
    await writeTranscript([legacyCli], sessionKey);
    const sessionEntry = createSessionEntry({
      totalTokens: 1_124_767,
      totalTokensFresh: true,
      compactionCount: 0,
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const run = () =>
      runDefaultPreflight(sessionEntry, {
        followupRun: createTestFollowupRun({
          provider: "anthropic",
          model: "claude",
          sessionId: "session",
          sessionKey,
        }),
        promptForEstimate: "",
        defaultModel: "anthropic/claude",
        sessionStore,
        sessionKey,
        storePath,
      });

    await run();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();

    await writeTranscript(
      [
        legacyCli,
        usageEvent(
          "repaired exact turn",
          {
            input: 67_932,
            output: 2_000,
            cacheRead: 18_944,
            totalTokens: 88_876,
            contextUsage: {
              state: "available",
              promptTokens: 86_876,
              totalTokens: 88_876,
            },
          },
          "cli",
        ),
      ],
      sessionKey,
    );
    await run();

    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBe(88_876);
  });
  it("keeps nonzero unavailable output as growth after the previous exact snapshot", async () => {
    await writeTranscript([
      usageEvent("large answer", {
        input: 128_814,
        output: 10_000,
        cacheRead: 992_953,
        totalTokens: 1_131_767,
        contextUsage: { state: "unavailable" },
      }),
    ]);
    const sessionEntry: SessionEntry = createFreshSessionEntry({
      totalTokens: 72_000,
    });

    await runDefaultPreflight(sessionEntry, {
      promptForEstimate: "continue",
    });

    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBeGreaterThanOrEqual(
      82_000,
    );
  });

  it("does not add unavailable output twice when full-message estimation already includes it", async () => {
    await writeTranscript([
      usageEvent("x".repeat(3_600), {
        input: 1,
        output: 200,
        totalTokens: 201,
        contextUsage: { state: "unavailable" },
      }),
    ]);
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 0, reserveTokensFloor: 0 }),
    );
    const sessionEntry = createSessionEntry({
      totalTokensFresh: false,
    });

    await runDefaultPreflight(sessionEntry, {
      promptForEstimate: "",
      modelContextTokens: 1_000,
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("includes appended transcript growth before persisting fresh usage", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    await writeTranscript([
      usageEvent("small answer", { input: 40_000, output: 2_000 }),
      {
        type: "message",
        message: {
          role: "user",
          content: `large follow-up ${"x".repeat(450_000)}`,
        },
      },
    ]);
    const sessionEntry = createSessionEntry({
      totalTokensFresh: false,
      compactionCount: 0,
      // A prior flush prevents a new model usage report from hiding the stale anchor.
      memoryFlush: { kind: "succeeded", compactionCount: 0 },
    });
    await writeTestSessionStore(storePath, "main", sessionEntry);

    const flushResult = await runDefaultMemoryFlush(sessionEntry, { storePath });

    expect(flushResult.outcome).toBe("skipped");
    const persistedAfterFlush = loadMainSessionEntry(storePath);
    expect(persistedAfterFlush.totalTokensFresh).toBe(true);
    expect(persistedAfterFlush.totalTokens).toBeGreaterThan(80_000);

    await runDefaultPreflight(persistedAfterFlush, { storePath });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalled();
  });

  it.each(["plugin already stored this turn", "deferred to background context-engine maintenance"])(
    "fails required preflight compaction for a successful no-op: %s",
    async (reason) => {
      compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: true,
        compacted: false,
        reason,
      });
      const sessionEntry: SessionEntry = createFlushSessionEntry({
        totalTokens: 180_499,
        compactionCount: 0,
      });
      const sessionStore = { main: sessionEntry };
      const replyOperation = createReplyOperation();

      await expect(
        runDefaultPreflight(sessionEntry, {
          modelContextTokens: 200_000,
          sessionStore,
          sessionKey: "main",
          ...createCompactionLifecycle(replyOperation),
        }),
      ).rejects.toThrow(`Preflight compaction required but failed: ${reason}`);

      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
      const compactCall = requireCompactEmbeddedAgentSessionCall();
      expect(compactCall.contextTokenBudget).toBe(200_000);
      expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
      expect(
        replyOperation.setPhase.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      ).toBeLessThan(
        compactEmbeddedAgentSessionMock.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
      );
      expect(replyOperation.updateSessionId).not.toHaveBeenCalled();
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
      expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
    },
  );

  it("estimates Codex tool-result mirrors through the provider projection after provider usage after runtime cutover", async () => {
    const providerPromptTokens = 20_000;

    const scope = sessionScope("agent:main:telegram:default:direct:12345", "sessions.json");
    const { sessionKey, storePath } = scope;
    const output = "x".repeat(8_192);
    await writeTranscript(
      [
        usageEvent("Codex usage anchor", {
          input: providerPromptTokens,
          output: 100,
          totalTokens: providerPromptTokens + 100,
          contextUsage: {
            state: "available",
            promptTokens: providerPromptTokens,
            totalTokens: providerPromptTokens + 100,
          },
        }),
        ...Array.from({ length: 64 }, (_, index) => {
          const toolCallId = `call-${index}`;
          return [
            {
              type: "message" as const,
              message: {
                role: "assistant" as const,
                content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: {} }],
                usage: ZERO_USAGE_FIXTURE,
              },
            },
            {
              type: "message" as const,
              message: {
                role: "toolResult" as const,
                toolCallId,
                toolName: "exec",
                isError: false,
                content: [
                  {
                    type: "toolResult",
                    id: toolCallId,
                    name: "exec",
                    toolName: "exec",
                    toolCallId,
                    toolUseId: toolCallId,
                    tool_use_id: toolCallId,
                    text: output,
                    content: output,
                  },
                ],
              },
            },
          ];
        }).flat(),
      ],
      sessionKey,
    );
    const transcriptBefore = readSessionTranscriptMessageEvents(scope);
    const sessionEntry = createSessionEntry({
      totalTokensFresh: false,
      agentHarnessId: "codex",
      agentRuntimeOverride: "openclaw",
    });
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "guard_blocked",
    });

    const entry = await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey,
      }),
      defaultModel: "gpt-5.5",
      modelContextTokens: 128_000,
      sessionKey,
      storePath,
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(readSessionTranscriptMessageEvents(scope)).toEqual(transcriptBefore);
  });

  it("combines latest usage with post-usage tail pressure across 513 display-only messages", async () => {
    const activityCount = 513;

    await writeTranscript([
      usageEvent("small answer", { input: 90_000, output: 2_000 }),
      ...Array.from({ length: activityCount }, () => ({
        type: "message",
        message: {
          role: "custom",
          customType: "tool-activity",
          display: true,
          excludeFromContext: true,
          content: "completed",
        },
      })),
      {
        type: "message",
        message: {
          role: "user",
          content: `moderate follow-up ${"x".repeat(36_000)}`,
        },
      },
    ]);
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry = createSessionEntry({
      totalTokensFresh: false,
    });

    await runDefaultPreflight(sessionEntry, {});

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
  });

  it("preserves token-pressure compaction while byte retries are latched", async () => {
    const fixture = await createOversizedByteCompactionFixture();

    await fixture.run(fixture.sessionEntry);
    const tokenHeavyEntry: SessionEntry = {
      ...loadMainSessionEntry(fixture.storePath),
      totalTokens: 90_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await fixture.run(tokenHeavyEntry);

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(requireCompactEmbeddedAgentSessionCall(1).preflightCompactionTrigger).toBe("tokens");
  });

  it("latches upgraded Codex byte preflight when the successful mock omits the host callback", async () => {
    const scope = sessionScope("agent:main:main", "sqlite-codex-byte-guard-upgraded.json");
    const { sessionKey, storePath } = scope;
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const replyOperation = createReplyOperation();
    const run = async (entry: SessionEntry | undefined) =>
      await runCodexBytePreflight(entry, {
        sessionStore,
        sessionKey,
        storePath,
        ...createCompactionLifecycle(replyOperation),
      });

    let entry = await run(sessionEntry);
    entry = await run(entry);

    expect(entry?.compactionCount).toBe(1);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      agentHarnessId: "codex",
      contextTokenBudget: 1_000_000,
      deferOwningContextEngineCompaction: false,
      preflightCompactionTrigger: "transcript_bytes",
      preflightRequired: true,
      sessionId: "session",
      sessionKey,
      trigger: "budget",
    });
    expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[1]).toMatchObject({
      transcriptBytePreflightHarness: "codex",
      onHostCompactionCommitted: expect.any(Function),
    });
    const latchedEntry = loadSessionEntry({ storePath, sessionKey });
    expect(latchedEntry?.transcriptByteCompactionLatch).toMatchObject({
      sessionId: "session",
      maxBytes: 10,
    });
    const latchedBytes = latchedEntry?.transcriptByteCompactionLatch?.activeBytes ?? 0;
    expect(latchedBytes).toBeGreaterThan(0);

    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(260) }, type: "message" },
    ]);
    const growthBytes = readActiveTranscriptStats(scope).sizeBytes - latchedBytes;
    expect(growthBytes).toBeGreaterThan(0);
    expect(growthBytes).toBeLessThan(10);
    entry = await run(entry);
    expect(entry?.compactionCount).toBe(1);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);

    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(512) }, type: "message" },
    ]);
    entry = await run(entry);

    expect(entry?.compactionCount).toBe(2);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(
      loadSessionEntry({ storePath, sessionKey })?.transcriptByteCompactionLatch?.activeBytes,
    ).toBeGreaterThan(latchedBytes);
  });

  it("records tokens compaction before a queued continuation claims the session", async () => {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "preflight-handoff.json");
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 95_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
      activeWriterRunId: "preflight",
    });
    const manager = await SessionManager.openAsync(scope, rootDir);
    await manager.appendMessageAsync(makeUserMessage("Earlier discussion. ".repeat(100), 1));
    const entry = loadSessionEntry(scope)!;
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);
    compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
      await host?.onHostCompactionCommitted?.({
        entry,
        tokensAfter: 42,
        compactionKind: "context-engine",
      });
      // The backend releases its lane before its caller's await resumes.
      await upsertSessionEntryCore(scope, { activeWriterRunId: "queued-continuation" });
      return {
        ok: true,
        compacted: true,
        compactionKind: "context-engine",
        result: { tokensAfter: 42 },
      };
    });

    await expect(
      runDefaultPreflight(entry, {
        sessionKey,
        storePath,
        cfg: compactionConfig({
          maxActiveTranscriptBytes: "100mb",
        }),
      }),
    ).resolves.toMatchObject({ compactionCount: 1 });
    expect(loadSessionEntry(scope)).toMatchObject({
      activeWriterRunId: "queued-continuation",
      compactionCount: 1,
    });
    expect(incrementCompactionCountMock).toHaveBeenCalledOnce();
  });

  it("persists Codex byte accounting before the accepted compactor returns", async () => {
    const scope = sessionScope("agent:main:main", "sqlite-codex-held-accounting.json");
    const { sessionKey, storePath } = scope;
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    const manager = await SessionManager.openAsync(scope, rootDir);
    await manager.appendMessageAsync(makeUserMessage("x".repeat(256), 1));
    const activeBytes = readActiveTranscriptStats(scope).sizeBytes;
    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    const accountingCommitted = createDeferred();
    const releaseCompactor = createDeferred();
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);
    compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
      const firstKeptEntryId = manager.getLeafId();
      expect(firstKeptEntryId).toBeTruthy();
      await withSessionCompactionPersistenceAsync(
        manager,
        host?.withCompactionPersistenceAsync,
        () => manager.appendCompactionAsync("summary", firstKeptEntryId!, 100),
      );
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        compactionCount: 1,
        transcriptByteCompactionLatch: {
          activeBytes,
          sessionId: "session",
          maxBytes: 10,
        },
      });
      const accepted = await acceptCompactionSuccessor({
        currentTarget: scope,
        expectedEntry: {
          sessionId: sessionEntry.sessionId,
          lifecycleRevision: sessionEntry.lifecycleRevision,
          activeWriterRunId: sessionEntry.activeWriterRunId,
        },
        assertActive: () => {},
        result: {
          ok: true,
          compacted: true,
          result: { sessionId: sessionEntry.sessionId, tokensBefore: 10, tokensAfter: 42 },
        },
      });
      host?.onCommitted?.(accepted);
      await host?.onHostCompactionCommitted?.({
        entry: accepted.entry,
        tokensAfter: 42,
        compactionKind: "context-engine",
      });
      expect(loadSessionEntry({ storePath, sessionKey })?.compactionCount).toBe(1);
      accountingCommitted.resolve();
      await releaseCompactor.promise;
      return {
        ok: true,
        compacted: true,
        compactionKind: "context-engine",
        result: { tokensAfter: 42 },
      };
    });
    const pending = runCodexBytePreflight(sessionEntry, {
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: true,
    });
    try {
      await Promise.race([
        accountingCommitted.promise,
        pending.then(() => {
          throw new Error("Preflight returned before the compactor release");
        }),
      ]);
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        compactionCount: 1,
        transcriptByteCompactionLatch: {
          sessionId: "session",
          maxBytes: 10,
        },
      });
      expect(
        loadSessionEntry({ storePath, sessionKey })?.transcriptByteCompactionLatch?.activeBytes,
      ).toBeGreaterThanOrEqual(activeBytes);
      releaseCompactor.resolve();
      await pending;
      expect(loadSessionEntry({ storePath, sessionKey })?.compactionCount).toBe(1);
    } finally {
      releaseCompactor.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("refreshes the Codex byte latch after maintenance shrinks an oversized transcript", async () => {
    const fixture = await createOversizedByteCompactionFixture();
    const sessionKey = "main";
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      storePath: fixture.storePath,
    };
    const sessionEntry: SessionEntry = {
      ...fixture.sessionEntry,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };
    await upsertSessionEntryCore(scope, sessionEntry);
    const run = async (entry: SessionEntry) =>
      await runCodexBytePreflight(entry, {
        sessionKey,
        storePath: fixture.storePath,
        isHeartbeat: true,
      });
    const initialBytes = readActiveTranscriptStats(scope).sizeBytes;
    let settledBytes = 0;
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);
    compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
      const accepted = await acceptCompactionSuccessor({
        currentTarget: scope,
        expectedEntry: {
          sessionId: sessionEntry.sessionId,
          lifecycleRevision: sessionEntry.lifecycleRevision,
          activeWriterRunId: sessionEntry.activeWriterRunId,
        },
        assertActive: () => {},
        result: {
          ok: true,
          compacted: true,
          result: { sessionId: "session", tokensBefore: 10, tokensAfter: 42 },
        },
      });
      host?.onCommitted?.(accepted);
      const commit = {
        entry: accepted.entry,
        tokensAfter: 42,
        compactionKind: "context-engine" as const,
      };
      await host?.onHostCompactionCommitted?.(commit);
      await replaceTranscriptEvents(scope, [
        { type: "message", message: { role: "user", content: "x".repeat(128) } },
      ]);
      settledBytes = readActiveTranscriptStats(scope).sizeBytes;
      await host?.onHostCompactionTranscriptSettled?.(commit);
      return {
        ok: true,
        compacted: true,
        compactionKind: "context-engine",
        result: { tokensAfter: 42 },
      };
    });

    await run(sessionEntry);
    await run(loadMainSessionEntry(fixture.storePath));

    expect(settledBytes).toBeGreaterThan(10);
    expect(settledBytes).toBeLessThan(initialBytes);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(loadMainSessionEntry(fixture.storePath).compactionCount).toBe(1);
    expect(loadMainSessionEntry(fixture.storePath).transcriptByteCompactionLatch).toEqual({
      activeBytes: settledBytes,
      sessionId: "session",
      maxBytes: 10,
    });
  });

  it("clears a Codex byte latch after shrink below the cap without compacting", async () => {
    const scope = sessionScope("agent:main:main", "sqlite-codex-shrink-below-cap.json");
    const { sessionKey, storePath } = scope;
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "small" }, type: "message" },
    ]);
    const activeBytes = readActiveTranscriptStats(scope).sizeBytes;
    const sessionEntry = createSessionEntry({
      compactionCount: 1,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
      transcriptByteCompactionLatch: {
        activeBytes: activeBytes + 100,
        sessionId: "session",
        maxBytes: activeBytes + 1,
      },
    });
    await upsertSessionEntryCore(scope, sessionEntry);
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);

    await runCodexBytePreflight(sessionEntry, {
      cfg: compactionConfig({ maxActiveTranscriptBytes: `${activeBytes + 1}b` }),
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      sessionKey,
      storePath,
      isHeartbeat: true,
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.compactionCount).toBe(1);
    expect(
      loadSessionEntry({ storePath, sessionKey })?.transcriptByteCompactionLatch,
    ).toBeUndefined();
  });

  it.each([
    {
      name: "session identity",
      latch: { activeBytes: 1, sessionId: "other-session", maxBytes: 10 },
    },
    {
      name: "threshold",
      latch: { activeBytes: 1, sessionId: "session", maxBytes: 20 },
    },
  ])("resets a Codex byte latch on $name mismatch and rearms compaction", async ({ latch }) => {
    const storePath = path.join(
      rootDir,
      `sqlite-codex-latch-${latch.sessionId}-${latch.maxBytes}.json`,
    );
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    const sessionEntry = createSessionEntry({
      compactionCount: 1,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
      transcriptByteCompactionLatch: latch,
    });
    await upsertSessionEntryCore(scope, sessionEntry);
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);

    const entry = await runCodexBytePreflight(sessionEntry, {
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      sessionKey,
      storePath,
      isHeartbeat: true,
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
    expect(entry?.compactionCount).toBe(2);
    expect(
      loadSessionEntry({ storePath, sessionKey })?.transcriptByteCompactionLatch,
    ).toMatchObject({
      sessionId: "session",
      maxBytes: 10,
    });
  });

  it("skips memory flush and byte preflight for CLI-owned sessions", async () => {
    registerClaudeCliBackend(true);
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ forceFlushTranscriptBytes: 10 }),
    );
    const scope = sessionScope("agent:main:main", "sqlite-cli-owned-session.json");
    const { sessionKey, storePath } = scope;
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
    });
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
          compaction: {
            memoryFlush: {},
            maxActiveTranscriptBytes: "10b",
          },
        },
      },
    } as const;
    const followupRun = createTestFollowupRun({
      provider: "anthropic",
      model: "claude-opus-4-6",
      sessionId: "session",
      sessionKey,
    });

    const flushResult = await runDefaultMemoryFlush(sessionEntry, {
      cfg,
      followupRun,
      sessionKey,
      storePath,
      replyOperation: createReplyOperation(),
    });
    const preflightEntry = await runDefaultPreflight(sessionEntry, {
      cfg,
      followupRun,
      sessionKey,
      storePath,
    });

    expect(flushResult).toEqual({ sessionEntry, outcome: "skipped" });
    expect(preflightEntry).toBe(sessionEntry);
    expect(preflightEntry?.compactionCount).toBe(0);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("preserves post-compaction context when prepared delivery ownership changes", async () => {
    const scope = sessionScope("agent:main:main", "sqlite-large-session.json");
    const { sessionKey, storePath } = scope;
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
    });
    const replyOperation = createReplyOperation();
    await fs.writeFile(
      path.join(rootDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Reload this required startup context after compaction.",
        "",
        "## Unrelated",
        "Do not inject this section.",
      ].join("\n"),
      "utf-8",
    );
    const inboundPrompt = "current inbound metadata";
    const messageToolPrompt = "message-tool delivery guidance";
    const automaticPrompt = "automatic delivery guidance";
    const independentPrompt = "group and operator context";
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionKey,
      workspaceDir: rootDir,
      extraSystemPrompt: [inboundPrompt, messageToolPrompt, independentPrompt].join("\n\n"),
    });
    const sourceReplyDeliveryRuntime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [followupRun.run],
      promptComponentByMode: {
        automatic: automaticPrompt,
        message_tool_only: messageToolPrompt,
      },
      promptComponentOffset: inboundPrompt.length + 2,
    });

    const entry = await runDefaultPreflight(sessionEntry, {
      cfg: compactionConfig({
        maxActiveTranscriptBytes: "10b",
        postCompactionSections: ["Session Startup"],
      }),
      followupRun,
      sessionKey,
      storePath,
      ...createCompactionLifecycle(replyOperation),
    });

    expect(entry?.compactionCount).toBe(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.trigger).toBe("budget");
    expect(compactCall.preflightCompactionTrigger).toBe("transcript_bytes");
    expect(followupRun.run.extraSystemPrompt).toContain(
      "Reload this required startup context after compaction.",
    );

    sourceReplyDeliveryRuntime.applyPreparedMode(followupRun.run, "automatic");
    expect(followupRun.run.extraSystemPrompt).toContain(automaticPrompt);
    expect(followupRun.run.extraSystemPrompt).not.toContain(messageToolPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(inboundPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(independentPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(
      "Reload this required startup context after compaction.",
    );
    expect(followupRun.run.extraSystemPrompt).not.toContain("Do not inject this section.");
  });

  it("keeps incognito preflight compaction in the process-local transcript store", async () => {
    const durableStorePath = path.join(rootDir, "durable-sessions.json");
    const sessionKey = "agent:main:dashboard:incognito-preflight";
    const sessionEntry: SessionEntry = createFlushSessionEntry({
      sessionId: "incognito-session",
      totalTokens: 90_000,
      compactionCount: 0,
    });

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: sessionEntry.sessionId,
        sessionKey,
      }),
      sessionKey,
      storePath: durableStorePath,
    });

    const expectedStorePath = resolveSessionStorePathForScope({
      agentId: "main",
      sessionKey,
      storePath: durableStorePath,
    });
    expect(
      (requireCompactEmbeddedAgentSessionCall() as { sessionTarget?: Record<string, unknown> })
        .sessionTarget,
    ).toMatchObject({
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath: expectedStorePath,
    });
    expect(incrementCompactionCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey, storePath: expectedStorePath }),
    );
  });

  it.each([
    { targetId: null, shouldCompact: false },
    { targetId: "missing", shouldCompact: true },
  ])(
    "preserves accounting for an initial leaf control targeting $targetId",
    async ({ targetId, shouldCompact }) => {
      const scope = {
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
      };
      await appendTranscriptEvent(scope, { type: "leaf", id: "leaf", parentId: null, targetId });
      await appendTranscriptEvent(scope, {
        message: {
          role: "assistant",
          content: "flat continuation",
          usage: { input: 90_000, output: 100 },
        },
      });
      await runDefaultPreflight(
        { sessionId: "session", updatedAt: Date.now(), totalTokensFresh: false },
        { agentHarnessId: "openclaw" },
      );
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(shouldCompact ? 1 : 0);
    },
  );

  it("reports failed memory maintenance on the parent run", async () => {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ forceFlushTranscriptBytes: 10 }),
    );
    const scope = sessionScope("agent:main:main", "sqlite-force-flush-session.json");
    const { sessionKey, storePath } = scope;
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    SessionManager.open(scope, rootDir).appendMessage({
      role: "user",
      content: "x".repeat(256),
      timestamp: 1,
    });
    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 10,
      compactionCount: 0,
    });
    const replyOperation = createReplyOperation();

    const statuses: unknown[] = [];
    onTestFinished(
      onAgentEventForRun("parent-memory-status", (event) => {
        if (event.stream === "run_status") {
          statuses.push(event.data);
        }
      }),
    );
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(statuses).toEqual([{ phase: "memory_flushing" }]);
      throw new Error("synthetic maintenance failure");
    });
    const result = await runDefaultMemoryFlush(sessionEntry, {
      opts: { runId: "parent-memory-status" },
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      sessionKey,
      storePath,
      replyOperation,
    });

    expect(result.outcome).toBe("failed");
    expect(statuses).toEqual([{ phase: "memory_flushing" }, { phase: "preparing_context" }]);
    expect(registerAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        isControlUiVisible: false,
        projectSessionMessages: false,
      }),
    );
    expect(replyOperation.setPhase).toHaveBeenCalledWith("memory_flushing");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("emits preflight compaction notices around a successful budget compaction", async () => {
    await writeTranscript([
      { type: "message", message: { role: "user", content: "x".repeat(5_000) } },
    ]);
    const sessionEntry: SessionEntry = createFlushSessionEntry({
      totalTokens: 120,
      compactionCount: 0,
    });
    const onCompactionNotice = vi.fn();
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "server-endpoint",
      result: { kind: "server-endpoint", tokensBefore: 8_614, tokensAfter: 736 },
    });

    await runDefaultPreflight(sessionEntry, {
      cfg: compactionConfig({
        notifyUser: true,
        maxActiveTranscriptBytes: "10b",
      }),
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      onCompactionNotice,
    });

    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(
      2,
      "end",
      "🧹 Server-side compaction complete (8.6k → 736)",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
