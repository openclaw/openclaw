import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applySessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  type createAgentAccountingPersistenceFixture,
} from "./agent-runner-result-accounting.persistence.test-support.js";

export function registerAccountingReplacementRaceCases(
  createFixture: () => ReturnType<typeof createAgentAccountingPersistenceFixture>,
) {
  describe.each(["ordinary", "followup"] as const)("%s accounting replacement races", (lane) => {
    it.each([
      { name: "session", replacement: { sessionId: "replacement-session" } },
      { name: "lifecycle", replacement: { lifecycleRevision: "generation-2" } },
      { name: "writer", replacement: { activeWriterRunId: "newer-writer" } },
    ])(
      "does not compact replacement $name telemetry after the old owner resumes",
      async ({ name, replacement }) => {
        const fixture = await createFixture();
        fixture.recordCompaction();
        const pendingTool = createDeferred();
        fixture.context.pendingToolTasks.add(pendingTool.promise);
        const accounting = fixture.account(lane, {
          compactionCount: 1,
          usage: { input: 120 },
          lastCallUsage: { input: 120 },
        });
        // Simulate an old closure surviving forced terminal-settlement release.
        // Normal competing reset/delete waits for admission; this is the resumed
        // owner's write fence after replacement, not a claim that reset bypasses it.
        const next: SessionEntry = {
          ...fixture.context.activeSessionEntry!,
          ...(name === "session" ? { sessionId: `${fixture.sessionId}-replacement` } : replacement),
          updatedAt: 30,
          contextBudgetStatus: {
            ...diagnostic,
            updatedAt: 30,
            route: "fits",
            shouldCompact: false,
            estimatedPromptTokens: 100,
            remainingPromptBudgetTokens: 800,
            overflowTokens: 0,
          },
          compactionCount: 9,
          totalTokens: 666,
          totalTokensFresh: true,
          inputTokens: 500,
          outputTokens: 70,
          cacheRead: 50,
          cacheWrite: 5,
          estimatedCostUsd: 7,
        };
        await fixture.replace(next);
        const persisted = fixture.read();
        pendingTool.resolve();
        await expect(accounting).rejects.toThrow("Terminal accounting session changed");
        expect(fixture.read()).toEqual(persisted);
      },
    );

    it("keeps the admitted generation while pending tool work drains", async () => {
      const fixture = await createFixture();
      const pendingTool = createDeferred();
      fixture.context.pendingToolTasks.add(pendingTool.promise);
      const accounting = fixture.account(lane, { usage: { input: 120 } });
      const replacement = {
        ...fixture.context.activeSessionEntry!,
        lifecycleRevision: "generation-2",
        contextBudgetStatus: undefined,
      };
      await fixture.replace(replacement);
      Object.assign(fixture.context.activeSessionEntry!, replacement);
      const persisted = fixture.read();
      pendingTool.resolve();
      await expect(accounting).rejects.toThrow("Terminal accounting session changed");
      expect(fixture.read()).toEqual(persisted);
    });

    it("does not recreate a deleted session while accounting a completed result", async () => {
      const fixture = await createFixture();
      fixture.context.replyOperation.complete();
      await applySessionEntryLifecycleMutation({
        storePath: fixture.context.storePath!,
        removals: [{ sessionKey: fixture.context.sessionKey! }],
        skipMaintenance: true,
      });
      await expect(fixture.account(lane, { usage: { input: 120 } })).rejects.toThrow();
      expect(fixture.read()).toBeUndefined();
    });
  });
}
