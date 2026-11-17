import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  createFlushSessionEntry,
  createModifiedMemoryFlushPlan,
} from "./agent-runner-memory.test-support.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const { compact, defersToChatGPT } = vi.hoisted(() => ({
  compact: vi.fn(),
  defersToChatGPT: vi.fn(async () => false),
}));
vi.mock("./agent-runner-memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory-runtime.js")>()),
  defersTokenCompactionToChatGPTBoundary: defersToChatGPT,
}));
// mock-isolation: the memory checkpoint is the test's callback; no embedded run may start.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
// mock-isolation: the compactor is observed, never run against a real model.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: vi.fn(async () => 1),
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: vi.fn(),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-notice-");
beforeEach(() => {
  vi.clearAllMocks();
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
  });
});
afterEach(() => clearMemoryPluginState());

// The memory checkpoint is a full model turn that can take minutes (#200270).
it.each([
  ["compacts", 90_000, false, ["notice start", "checkpoint", "compacted", "notice end"]],
  ["leaves nothing to compact", 10_000, false, ["notice start", "checkpoint", "notice skipped"]],
  // As before, a turn whose compaction waits for the ChatGPT boundary stays silent.
  ["hands compaction to ChatGPT", 90_000, true, ["checkpoint"]],
] as const)(
  "orders compaction notices around the memory checkpoint when the run %s",
  async (_outcome, tokensAfterCheckpoint, handsToChatGPT, expected) => {
    const events: string[] = [];
    defersToChatGPT.mockResolvedValue(handsToChatGPT);
    compact.mockImplementationOnce(async () => {
      events.push("compacted");
      return { ok: true, compacted: true, result: { tokensAfter: 42 } };
    });
    const sessionEntry = createFlushSessionEntry({ totalTokens: 90_000 });
    const followupRun = createTestFollowupRun({ sessionId: "session", sessionKey: "main" });
    const defaultModel = "anthropic/claude-opus-4-6";
    await runSessionCompactionIfNeeded({
      cfg: withTestModelContextTokens({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun,
        defaultModel,
        contextTokens: 100_000,
      }),
      followupRun,
      defaultModel,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
      onCompactionNotice: (phase) => void events.push(`notice ${phase}`),
      beforeCompaction: async () => {
        events.push("checkpoint");
        return { ...sessionEntry, totalTokens: tokensAfterCheckpoint };
      },
    });

    expect(events).toEqual(expected);
  },
);
