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
// The replan resolves its target again after the checkpoint; a test can fail that second resolution.
const target = vi.hoisted(() => ({
  failReplan: false,
  calls: 0,
}));
vi.mock("./agent-runner-memory-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-runner-memory-target.js")>();
  return {
    ...actual,
    resolveSessionCompactionTarget: (
      ...args: Parameters<typeof actual.resolveSessionCompactionTarget>
    ) => {
      if (target.failReplan && ++target.calls === 2) {
        throw new Error("replan stopped");
      }
      return actual.resolveSessionCompactionTarget(...args);
    },
  };
});
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: vi.fn(),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-notice-");
beforeEach(() => {
  vi.clearAllMocks();
  // Cases queue one-off results; an unused one must not leak into the next case.
  compact.mockReset();
  defersToChatGPT.mockReset();
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
  });
});
afterEach(() => {
  clearMemoryPluginState();
  Object.assign(target, { failReplan: false, calls: 0 });
});

type CompactionParams = Parameters<typeof runSessionCompactionIfNeeded>[0];
const flushEntry = () => createFlushSessionEntry({ totalTokens: 90_000 });
// Shared setup: a session past the threshold of a 100k-token model, compaction notices on.
function runCompaction(
  params: Pick<CompactionParams, "onCompactionNotice" | "beforeCompaction"> & {
    sessionEntry?: CompactionParams["sessionEntry"];
    notifyUser?: boolean;
    revocation?: AbortSignal;
  },
) {
  const { sessionEntry = flushEntry(), notifyUser = true, revocation, ...rest } = params;
  const followupRun = createTestFollowupRun({ sessionId: "session", sessionKey: "main" });
  if (revocation) {
    const scopes = ["operator.admin"];
    followupRun.operatorAuthority = {
      profileId: "admin",
      scopes,
      assertCurrent: () => {},
      signal: revocation,
    };
  }
  const defaultModel = "anthropic/claude-opus-4-6";
  const compaction = { memoryFlush: {}, notifyUser };
  return runSessionCompactionIfNeeded({
    cfg: withTestModelContextTokens({
      cfg: { agents: { defaults: { compaction } } },
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
    ...rest,
  });
}

// The memory checkpoint is a full model turn that can take minutes (#200270).
it.each([
  ["compacts", 90_000, false, "ok", ["notice start", "checkpoint", "compacted", "notice end"]],
  [
    "leaves nothing to compact",
    10_000,
    false,
    "ok",
    ["notice start", "checkpoint", "notice skipped"],
  ],
  // As before, a turn whose compaction waits for the ChatGPT boundary stays silent.
  ["hands compaction to ChatGPT", 90_000, true, "ok", ["checkpoint"]],
  ["fails its checkpoint", 90_000, false, "fails", ["notice start", "notice incomplete"]],
] as const)(
  "orders compaction notices around the memory checkpoint when the run %s",
  async (_outcome, tokensAfterCheckpoint, handsToChatGPT, checkpoint, expected) => {
    const events: string[] = [];
    defersToChatGPT.mockResolvedValue(handsToChatGPT);
    compact.mockImplementationOnce(async () => {
      events.push("compacted");
      return { ok: true, compacted: true, result: { tokensAfter: 42 } };
    });
    const sessionEntry = flushEntry();
    const run = runCompaction({
      sessionEntry,
      onCompactionNotice: (phase) => void events.push(`notice ${phase}`),
      beforeCompaction: async (_entry, announceStart) => {
        await announceStart();
        if (checkpoint === "fails") {
          throw new Error("checkpoint stopped");
        }
        events.push("checkpoint");
        return { ...sessionEntry, totalTokens: tokensAfterCheckpoint };
      },
    });

    await (checkpoint === "fails" ? expect(run).rejects.toThrow("checkpoint stopped") : run);
    expect(events).toEqual(expected);
  },
);

it("settles the start notice once when the replan after the memory checkpoint fails", async () => {
  const events: string[] = [];
  target.failReplan = true;
  const sessionEntry = flushEntry();
  const run = runCompaction({
    sessionEntry,
    onCompactionNotice: (phase) => void events.push(`notice ${phase}`),
    beforeCompaction: async (_entry, announceStart) => {
      await announceStart();
      events.push("checkpoint");
      return sessionEntry;
    },
  });

  await expect(run).rejects.toThrow("replan stopped");
  expect(events).toEqual(["notice start", "checkpoint", "notice incomplete"]);
});

it.each([
  // The callback stays for mandatory warnings; only notifyUser turns the start notice off.
  ["notifyUser is off", false, 0],
  ["the ChatGPT hand-over probe fails", true, 1],
] as const)("runs the memory checkpoint when %s", async (_case, notifyUser, probes) => {
  const events: string[] = [];
  defersToChatGPT.mockRejectedValue(new Error("provider hook failed"));
  const sessionEntry = flushEntry();
  await runCompaction({
    sessionEntry,
    notifyUser,
    onCompactionNotice: (phase) => void events.push(`notice ${phase}`),
    beforeCompaction: async (_entry, announceStart) => {
      await announceStart();
      events.push("checkpoint");
      // Nothing left to compact, so the replan never probes the hand-over again.
      return { ...sessionEntry, totalTokens: 10_000 };
    },
  });

  expect(events).toEqual(["checkpoint"]);
  expect(defersToChatGPT).toHaveBeenCalledTimes(probes);
});

// The memory flush and the compactor stop on this combined signal; the turn is being torn down, not failing.
it.each(["memory checkpoint", "compactor"] as const)(
  "sends no incomplete notice when operator authority is withdrawn during the %s",
  async (stage) => {
    const events: string[] = [];
    const revocation = new AbortController();
    const withdraw = () => {
      revocation.abort();
      throw new Error("operator access revoked");
    };
    compact.mockImplementationOnce(async () => withdraw());
    // Without a checkpoint the start notice precedes the compactor, whose own failure path settles it.
    const beforeCompaction: CompactionParams["beforeCompaction"] =
      stage === "memory checkpoint"
        ? async (_entry, announceStart) => {
            await announceStart();
            return withdraw();
          }
        : undefined;
    const run = runCompaction({
      revocation: revocation.signal,
      onCompactionNotice: (phase) => void events.push(`notice ${phase}`),
      beforeCompaction,
    });

    await expect(run).rejects.toThrow("operator access revoked");
    expect(events).toEqual(["notice start"]);
  },
);
