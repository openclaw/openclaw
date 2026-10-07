import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as sessionEntryWriter from "../../config/sessions/session-accessor.entry-mutation.js";
import type { SessionTranscriptAccountingSnapshot } from "../../config/sessions/session-transcript-accounting.types.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
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
    flushPlanResolver: () => ({
      softThresholdTokens: 4000,
      forceFlushTranscriptBytes: 1000,
      reserveTokensFloor: 20000,
      prompt: "Save memory",
      systemPrompt: "Save memory",
      relativePath: "memory/synthetic.md",
    }),
  });
});
afterEach(() => clearMemoryPluginState());

function runAccounting(
  kind: "memory" | "compaction",
  signal?: AbortSignal,
  assertCurrent?: () => void,
) {
  const followupRun = createTestFollowupRun();
  if (assertCurrent) {
    followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent,
    });
  }
  const params = {
    followupRun,
    defaultModel: "anthropic/claude-opus-4-6",
    sessionEntry: {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 10000,
      totalTokensFresh: false,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      ...(kind === "compaction"
        ? {
            transcriptByteCompactionLatch: {
              sessionId: "session",
              activeBytes: 3000,
              maxBytes: 1000,
            },
          }
        : {}),
    },
    sessionKey: "main",
    storePath: path.join(followupRun.run.workspaceDir, "sessions.json"),
    isHeartbeat: false,
    abortSignal: signal,
    cfg: withTestModelContextTokens({
      cfg: {
        agents: { defaults: { compaction: { maxActiveTranscriptBytes: 1000, memoryFlush: {} } } },
      },
      followupRun,
      defaultModel: "anthropic/claude-opus-4-6",
      contextTokens: 100000,
    }),
  };
  return kind === "memory"
    ? runMemoryFlushIfNeeded({ ...params, resolvedVerboseLevel: "off" })
    : runSessionCompactionIfNeeded(params);
}

it.each(["memory", "compaction"] as const)(
  "rechecks live authority after delayed %s accounting before effects",
  async (kind) => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const persist = vi.spyOn(sessionEntryWriter, "updateSessionEntry").mockResolvedValue(null);
    accounting.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return {
        byteSize: 2000,
        eventCount: 1,
        turnTainted: false,
        usage: { promptTokens: 90000, outputTokens: 7, trailingMessages: [] },
      };
    });
    const pending = runAccounting(kind, undefined, () => {
      if (!current) {
        throw new Error("authority retired during accounting");
      }
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "accounting was not awaited");
      expect(compact).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(runEntry).not.toHaveBeenCalled();
      current = false;
      const rejected = expect(pending).rejects.toThrow("authority retired during accounting");
      release.resolve();
      await rejected;
      expect(increment).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(compact).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(runEntry).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      persist.mockRestore();
    }
  },
);

it("keeps failed memory accounting conservative without a native retry", async () => {
  accounting.mockRejectedValue(new Error("accounting worker unavailable"));
  const result = await runAccounting("memory");
  expect(accounting).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ outcome: "skipped" });
  expect(flush).not.toHaveBeenCalled();
  expect(runEntry).not.toHaveBeenCalled();
});
