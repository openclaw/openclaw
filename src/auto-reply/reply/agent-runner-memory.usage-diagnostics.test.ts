import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
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
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import {
  createMemoryFlushPlan,
  createMemoryRunEntryMockImplementation,
  type EmbeddedAgentParams,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const { runEntry, runAgent } = vi.hoisted(() => ({ runEntry: vi.fn(), runAgent: vi.fn() }));
// mock-isolation: Keep provider entry and its process-global runtime state out of settlement proof.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEntry,
}));
// mock-isolation: Inference supplies completed usage; unrelated embedded operations must stay isolated.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runAgent }));

describe("private memory usage diagnostics", () => {
  const tempDirs = createTempDirTracker();
  let suiteRoot = "";
  let rootDir = "";
  beforeAll(() => {
    suiteRoot = tempDirs.make("openclaw-memory-usage-");
  });
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(suiteRoot);
    tempDirs.cleanup();
  });
  beforeEach(() => {
    rootDir = tempDirs.make("case-", suiteRoot);
    registerMemoryCapability("memory-core", { flushPlanResolver: createMemoryFlushPlan });
    runEntry.mockReset().mockImplementation(
      createMemoryRunEntryMockImplementation({
        runWithModelFallback: async ({ provider = "openai", model = "usage-fixture", run }) => ({
          result: await run(provider, model, {
            modelRoutingProvenance: {
              requestedProvider: provider,
              requestedModel: model,
              stage: "initial",
            },
          }),
          provider,
          model,
          attempts: [],
        }),
        ensureSelectedAgentHarnessPlugin: vi.fn().mockResolvedValue(undefined),
      }),
    );
    runAgent.mockReset();
  });
  afterEach(() => {
    clearMemoryPluginState();
  });

  it.each([false, true])("settles usage independently of a returned error: %s", async (isError) => {
    const events: Extract<DiagnosticEventPayload, { type: "model.usage" }>[] = [];
    onTestFinished(
      onTrustedInternalDiagnosticEvent((event) => {
        if (event.type === "model.usage") {
          events.push(event);
        }
      }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 10,
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
    };
    const followupRun = createTestFollowupRun({ workspaceDir: rootDir, agentDir: rootDir });
    const storePath = path.join(rootDir, "sessions.json");
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runAgent.mockImplementationOnce(async (params: EmbeddedAgentParams) => ({
      payloads: isError ? [{ text: "synthetic memory write failed", isError: true }] : [],
      meta: {
        durationMs: 123,
        agentMeta: {
          sessionId: params.sessionId,
          provider: "openai",
          model: "usage-fixture",
          usage: { input: 10, output: 5 },
          diagnosticUsage: {
            input: 100,
            output: 40,
            cacheRead: 20,
            cacheWrite: 10,
            cost: { total: 0.125 },
          },
          lastCallUsage: { input: 10, output: 5 },
          promptTokens: 10,
          contextTokens: 100_000,
        },
      },
    }));
    const defaultModel = "usage-fixture";
    const result = await runMemoryFlushIfNeeded({
      cfg: withTestModelContextTokens({
        cfg: {
          agents: { defaults: { compaction: { memoryFlush: {} } } },
          diagnostics: { enabled: true },
        },
        followupRun,
        defaultModel,
        contextTokens: 100_000,
      }),
      followupRun,
      defaultModel,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
    });
    expect(result.outcome).toBe(isError ? "failed" : "completed");
    expect(events).toHaveLength(1);
    const event = expectDefined(events[0], "memory flush usage diagnostic");
    expect(event).toMatchObject({
      agentId: "main",
      sessionKey: expect.stringMatching(/^agent:main:internal-session-effects:/),
      sessionId: expect.stringMatching(/^internal-session-effects-/),
      provider: "openai",
      model: "usage-fixture",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 20,
        cacheWrite: 10,
        promptTokens: 130,
        total: 170,
      },
      lastCallUsage: { input: 10, output: 5 },
      context: { limit: 100_000, used: 10 },
      costUsd: 0.125,
      durationMs: 123,
    });
    expect(event.channel).toBeUndefined();
    expect(followupRun.run.sessionId).toBe("session");
    expect(loadSessionEntry({ storePath, sessionKey: "main" })).not.toHaveProperty("inputTokens");
  });
});
