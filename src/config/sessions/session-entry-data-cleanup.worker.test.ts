import { expect, it, vi } from "vitest";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readExpiredCronRunEntriesInWorker } from "./session-entry-read-maintenance.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";

it("checks the captured registry after cron data cleanup", async () => {
  await withOpenClawTestState({ label: "readonly-entry-cleanup" }, async ({ env, path }) => {
    const storePath = path("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
    const sessionKey = "agent:main:cron:job:run:cleanup";
    writeSessionEntry(database, sessionKey, { sessionId: "cleanup-session", updatedAt: 1 });
    const pool = targetDiscoveryLane.pool;
    const rotate = pool.rotate.bind(pool);
    const closeResources = pool.closeResources.bind(pool);
    let cleanupCalled = false;
    const invalidateAfterCleanup = () => {
      if (cleanupCalled) {
        return;
      }
      cleanupCalled = true;
      invalidateRegisteredAgentDatabasesMemo({ env });
    };
    const rotateCleanup = vi.spyOn(pool, "rotate").mockImplementation(async () => {
      await rotate();
      invalidateAfterCleanup();
    });
    const resourceCleanup = vi.spyOn(pool, "closeResources").mockImplementation(async (key) => {
      await closeResources(key);
      invalidateAfterCleanup();
    });
    try {
      const pending = readExpiredCronRunEntriesInWorker({
        agentId: "main",
        storePath,
        env,
        updatedBefore: 2,
      });
      await expect(pending).rejects.toThrow("registry changed");
      expect(cleanupCalled).toBe(true);
    } finally {
      rotateCleanup.mockRestore();
      resourceCleanup.mockRestore();
    }
  });
});
