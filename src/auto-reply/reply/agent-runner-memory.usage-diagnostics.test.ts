import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import * as memoryState from "../../plugins/memory-state.test-fixtures.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import * as memoryFixture from "./agent-runner-memory.test-support.js";
import * as fixture from "./agent-runner.test-fixtures.js";

const { runEntry, runAgent } = vi.hoisted(() => ({ runEntry: vi.fn(), runAgent: vi.fn() }));
// mock-isolation: Keep provider entry and its process-global runtime state out of settlement proof.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEntry,
}));
// mock-isolation: Inference supplies completed usage; unrelated embedded operations must stay isolated.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runAgent }));

afterEach(memoryState.clearMemoryPluginState);

it.each([false, true])("settles usage independently of a returned error: %s", async (isError) => {
  const tempDirs = createTempDirTracker();
  const rootDir = tempDirs.make("openclaw-memory-usage-");
  onTestFinished(async () => {
    await closeOpenClawAgentDatabasesAsync(rootDir);
    tempDirs.cleanup();
  });
  memoryState.registerMemoryCapability("memory-core", {
    flushPlanResolver: memoryFixture.createMemoryFlushPlan,
  });
  runEntry.mockReset().mockImplementation(
    memoryFixture.createMemoryRunEntryMockImplementation({
      runWithModelFallback: memoryFixture.runSelectedMemoryModel,
      ensureSelectedAgentHarnessPlugin: vi.fn().mockResolvedValue(undefined),
    }),
  );
  runAgent.mockReset();
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
  const followupRun = fixture.createTestFollowupRun({ workspaceDir: rootDir, agentDir: rootDir });
  const storePath = path.join(rootDir, "sessions.json");
  await fixture.writeTestSessionStore(storePath, "main", sessionEntry);
  const diagnosticUsage = { input: 100, output: 40, cacheRead: 20, cacheWrite: 10 };
  const lastCallUsage = { input: 10, output: 5 };
  const model = { provider: "openai", model: "usage-fixture" };
  runAgent.mockImplementationOnce(async (params: memoryFixture.EmbeddedAgentParams) => ({
    payloads: isError ? [{ text: "synthetic memory write failed", isError: true }] : [],
    meta: {
      durationMs: 123,
      agentMeta: {
        sessionId: params.sessionId,
        ...model,
        usage: lastCallUsage,
        diagnosticUsage: { ...diagnosticUsage, cost: { total: 0.125 } },
        lastCallUsage,
        promptTokens: 10,
        contextTokens: 100_000,
      },
    },
  }));
  const defaultModel = "usage-fixture";
  const result = await runMemoryFlushIfNeeded({
    cfg: fixture.withTestModelContextTokens({
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
  });
  expect(result.outcome).toBe(isError ? "failed" : "completed");
  expect(events).toMatchObject([
    {
      agentId: "main",
      sessionKey: expect.stringMatching(/^agent:main:internal-session-effects:/),
      sessionId: expect.stringMatching(/^internal-session-effects-/),
      ...model,
      usage: { ...diagnosticUsage, promptTokens: 130, total: 170 },
      lastCallUsage,
      context: { limit: 100_000, used: 10 },
      costUsd: 0.125,
      durationMs: 123,
    },
  ]);
  expect(events[0]?.channel).toBeUndefined();
  expect(followupRun.run.sessionId).toBe("session");
  expect(loadSessionEntry({ storePath, sessionKey: "main" })).not.toHaveProperty("inputTokens");
});
