import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionTranscriptAccountingSnapshot } from "../../config/sessions/session-transcript-accounting.types.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createModifiedMemoryFlushPlan } from "./agent-runner-memory.test-support.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const { accounting, compact, flush, runEntry, increment } = vi.hoisted(() => ({
  accounting: vi.fn<() => Promise<SessionTranscriptAccountingSnapshot>>(),
  compact: vi.fn(),
  flush: vi.fn(),
  runEntry: vi.fn(),
  increment: vi.fn(),
}));
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionTranscriptAccountingAsync: accounting,
}));
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEntry,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compact,
  runEmbeddedAgent: flush,
}));
vi.mock("./session-updates.js", () => ({ incrementCompactionCount: increment }));

beforeEach(() => {
  vi.clearAllMocks();
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () => createModifiedMemoryFlushPlan({ forceFlushTranscriptBytes: 1000 }),
  });
});
afterEach(() => clearMemoryPluginState());

function runAccounting(kind: "memory" | "compaction", alreadyFlushed = false) {
  const followupRun = createTestFollowupRun();
  const params = {
    followupRun,
    defaultModel: "anthropic/claude-opus-4-6",
    sessionEntry: {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 10000,
      totalTokensFresh: false,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      memoryFlush: alreadyFlushed ? { kind: "succeeded" as const, compactionCount: 0 } : undefined,
      transcriptByteCompactionLatch:
        kind === "compaction"
          ? { sessionId: "session", activeBytes: 3000, maxBytes: 1000 }
          : undefined,
    },
    sessionKey: "main",
    storePath: path.join(followupRun.run.workspaceDir, "sessions.json"),

    cfg: {
      agents: { defaults: { compaction: { maxActiveTranscriptBytes: 1000, memoryFlush: {} } } },
    },
  };
  const execute = kind === "memory" ? runMemoryFlushIfNeeded : runSessionCompactionIfNeeded;
  return execute({
    ...params,
    cfg: withTestModelContextTokens({ ...params, contextTokens: 100000 }),
    resolvedVerboseLevel: "off",
  });
}

it.each([
  { state: "unavailable accounting", alreadyFlushed: false, reads: 1 },
  { state: "already flushed", alreadyFlushed: true, reads: 0 },
])("skips memory flush with $state without retrying history", async ({ alreadyFlushed, reads }) => {
  accounting.mockRejectedValue(new Error("accounting worker unavailable"));
  const result = await runAccounting("memory", alreadyFlushed);
  expect(accounting).toHaveBeenCalledTimes(reads);
  expect(result).toMatchObject({ outcome: "skipped" });
  expect(flush).not.toHaveBeenCalled();
  expect(runEntry).not.toHaveBeenCalled();
});
