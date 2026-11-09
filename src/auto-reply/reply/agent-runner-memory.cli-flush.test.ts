// Tests the pre-compaction memory flush on CLI backends that own compaction natively.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  readTranscriptStatsSync,
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  runMemoryFlushIfNeeded as runMemoryFlushIfNeededRaw,
  runSessionCompactionIfNeeded,
} from "./agent-runner-memory.js";
import {
  createFlushSessionEntry,
  createModifiedMemoryFlushPlan,
  createMemoryRunEntryMockImplementation,
  runSelectedMemoryModel,
} from "./agent-runner-memory.test-support.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import { createMockReplyOperation } from "./test-helpers.js";

const { compactEmbeddedAgentSessionMock, runEmbeddedAgentEntryMock, runEmbeddedAgentMock } =
  vi.hoisted(() => ({
    compactEmbeddedAgentSessionMock: vi.fn(),
    runEmbeddedAgentEntryMock: vi.fn(),
    runEmbeddedAgentMock: vi.fn(),
  }));
const runWithModelFallbackMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();

// mock-isolation: Observe the flush turn and compactor admission without executing a model.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEmbeddedAgentEntryMock,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

const MODEL_CONTEXT_TOKENS = 100_000;
const cfg = {
  agents: {
    defaults: {
      models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
      compaction: { memoryFlush: {}, maxActiveTranscriptBytes: "10b" },
    },
  },
} as const;

let suiteRoot = "";
let caseCount = 0;

beforeAll(async () => {
  // openclaw-temp-dir: allow removal must await the agent database drain below
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-cli-"));
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync(suiteRoot);
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        ownsNativeCompaction: true,
      },
    ],
  });
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () => createModifiedMemoryFlushPlan({ forceFlushTranscriptBytes: 10 }),
  });
  runWithModelFallbackMock.mockReset().mockImplementation(runSelectedMemoryModel);
  runEmbeddedAgentEntryMock.mockReset().mockImplementation(
    createMemoryRunEntryMockImplementation({
      runWithModelFallback: runWithModelFallbackMock,
      ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginMock,
    }),
  );
  ensureSelectedAgentHarnessPluginMock.mockReset().mockResolvedValue(undefined);
  runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
  compactEmbeddedAgentSessionMock.mockReset();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  cliBackendsTesting.resetDepsForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearMemoryPluginState();
});

async function seedCliSession(memoryFlush?: SessionEntry["memoryFlush"]) {
  const rootDir = path.join(suiteRoot, `case-${++caseCount}`);
  await fs.mkdir(rootDir);
  const scope = {
    agentId: "main",
    sessionId: "session",
    sessionKey: "agent:main:main",
    storePath: path.join(rootDir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
  const manager = await SessionManager.openAsync(scope, rootDir);
  await manager.appendMessageAsync(makeUserMessage("x".repeat(256), 1));
  await waitForSessionTranscriptProjection(scope);
  expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);
  const sessionEntry: SessionEntry = {
    ...createFlushSessionEntry({ totalTokens: 10, compactionCount: 0 }),
    ...(memoryFlush ? { memoryFlush } : {}),
  };
  const followupRun = createTestFollowupRun({
    provider: "anthropic",
    model: "claude-opus-4-6",
    sessionId: "session",
    sessionKey: scope.sessionKey,
  });
  const defaultModel = "anthropic/claude-opus-4-6";
  const runtimeCfg = withTestModelContextTokens({
    cfg,
    followupRun,
    defaultModel,
    contextTokens: MODEL_CONTEXT_TOKENS,
  });
  setRuntimeConfigSnapshot(runtimeCfg);
  const common = {
    cfg: runtimeCfg,
    followupRun,
    defaultModel,
    sessionEntry,
    sessionStore: { [scope.sessionKey]: sessionEntry },
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
  };
  const { replyOperation } = createMockReplyOperation({ key: "test" });
  return {
    sessionEntry,
    flush: () =>
      runMemoryFlushIfNeededRaw({ ...common, resolvedVerboseLevel: "off", replyOperation }),
    preflight: () => runSessionCompactionIfNeeded(common),
    // Reply and command turns reach the flush only through this hook.
    preflightWithFlush: () =>
      runSessionCompactionIfNeeded({
        ...common,
        beforeCompaction: async (current) =>
          (
            await runMemoryFlushIfNeededRaw({
              ...common,
              sessionEntry: current,
              resolvedVerboseLevel: "off",
              replyOperation,
            })
          ).sessionEntry,
      }),
    persisted: () => loadSessionEntry({ storePath: scope.storePath, sessionKey: "main" }),
  };
}

describe("runMemoryFlushIfNeeded on CLI-owned sessions", () => {
  it("flushes through the CLI dispatch with a bounded grant and leaves compaction native", async () => {
    const { sessionEntry, flush, preflight, persisted } = await seedCliSession();

    expect((await flush()).outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const flushParams = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(flushParams).toMatchObject({
      trigger: "memory",
      cliBackendDispatch: "subscription-auth",
      toolsAllow: ["read", "write"],
      transcriptPrompt: "",
    });
    expect(flushParams?.memoryFlushWritePath).toEqual(expect.any(String));
    expect(persisted()?.memoryFlush).toEqual({
      kind: "succeeded",
      compactionCount: 0,
      cliRearmBucket: 0,
    });

    // The backend still owns compaction; only the memory flush is lifted.
    const preflightEntry = await preflight();
    expect(preflightEntry).toBe(sessionEntry);
    expect(preflightEntry?.compactionCount).toBe(0);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("runs the flush from the preflight hook without compacting", async () => {
    const { preflightWithFlush, persisted } = await seedCliSession();

    const entry = await preflightWithFlush();

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({ trigger: "memory" });
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(entry?.memoryFlush).toMatchObject({ kind: "succeeded", cliRearmBucket: 0 });
    expect(persisted()?.memoryFlush).toMatchObject({ cliRearmBucket: 0 });
  });

  it("suppresses a second flush in the same transcript-byte window", async () => {
    const { sessionEntry, flush } = await seedCliSession({
      kind: "succeeded",
      compactionCount: 0,
      cliRearmBucket: 0,
    });

    expect(await flush()).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("re-arms once the transcript leaves the flushed window", async () => {
    // compactionCount never advances on CLI backends, so the old watermark alone
    // would suppress this forever; the byte window is what re-arms it.
    const { flush, persisted } = await seedCliSession({
      kind: "succeeded",
      compactionCount: 0,
      cliRearmBucket: 7,
    });

    expect((await flush()).outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(persisted()?.memoryFlush).toMatchObject({ cliRearmBucket: 0 });
  });

  it("does not let a failed record suppress its bucket", async () => {
    const { flush } = await seedCliSession({
      kind: "failed",
      cliRearmBucket: 0,
      failureCount: 1,
    });

    expect((await flush()).outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });
});
