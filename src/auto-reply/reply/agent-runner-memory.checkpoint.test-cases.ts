import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { CompactEmbeddedAgentSessionParams } from "./agent-runner-memory.test-support.js";
import type { SessionCompactionRunParams } from "./agent-runner-memory.types.js";

/** Keep checkpoint cases on the existing suite's real fixture lifecycle. */
export function registerCompactionCheckpointTests({
  createFlushSessionEntry,
  runDefaultPreflight,
  compactionConfig,
  compactEmbeddedAgentSessionMock,
  requireCompactEmbeddedAgentSessionCall,
  incrementCompactionCountMock,
}: {
  createFlushSessionEntry: (overrides?: Partial<SessionEntry>) => SessionEntry;
  runDefaultPreflight: (
    entry: SessionEntry | undefined,
    overrides?: Partial<SessionCompactionRunParams>,
  ) => Promise<SessionEntry | undefined>;
  compactionConfig: (
    compaction: AgentDefaultsConfig["compaction"],
  ) => SessionCompactionRunParams["cfg"];
  compactEmbeddedAgentSessionMock: Mock<
    typeof import("../../agents/embedded-agent.js").compactEmbeddedAgentSession
  >;
  requireCompactEmbeddedAgentSessionCall: () => CompactEmbeddedAgentSessionParams;
  incrementCompactionCountMock: Mock<
    typeof import("./session-updates.js").incrementCompactionCount
  >;
}) {
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
      return { ok: true, compacted: true, result: { tokensBefore: 90_000, tokensAfter: 42 } };
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

  it("keeps required reply preflight available when proactive compaction is disabled", async () => {
    await runDefaultPreflight(createFlushSessionEntry({ totalTokens: 90_000 }), {
      cfg: compactionConfig({ enabled: false }),
    });
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({ preflightRequired: true });
  });

  it.each([true, false])(
    "services a model request below pressure only when enabled=%s",
    async (enabled) => {
      const entry = createFlushSessionEntry({ totalTokens: 10_000 });
      const checkpoint = vi.fn(async () => entry);
      const result = await runDefaultPreflight(entry, {
        cfg: compactionConfig({ enabled }),
        requestedCompaction: { focus: "Keep the unresolved migration" },
        beforeCompaction: checkpoint,
      });
      expect(checkpoint).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) {
        expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
          trigger: "budget",
          force: true,
          forcePreflight: false,
          customInstructions: "Keep the unresolved migration",
        });
        expect(result?.compactionCount).toBe((entry.compactionCount ?? 0) + 1);
      } else {
        expect(result).toBe(entry);
      }
    },
  );

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
}
