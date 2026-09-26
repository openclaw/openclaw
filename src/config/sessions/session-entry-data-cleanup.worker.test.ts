import { expect, it, vi } from "vitest";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  readExpiredCronRunEntriesInWorker,
  readSessionEntriesFromStoreInWorker,
} from "./session-entry-read-runtime.js";
import { historyLane, maintenanceLane } from "./session-transcript-worker-resources.js";

it.each(["batch", "cron"] as const)(
  "checks the captured registry after %s data cleanup",
  async (kind) => {
    await withOpenClawTestState({ label: "readonly-entry-cleanup" }, async ({ env, path }) => {
      const storePath = path("shared.sqlite");
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
      const sessionKey = "agent:main:cron:job:run:cleanup";
      writeSessionEntry(database, sessionKey, { sessionId: "cleanup-session", updatedAt: 1 });
      const pool = kind === "cron" ? maintenanceLane.pool : historyLane.pool;
      const rotate = pool.rotate.bind(pool);
      const closeResources = pool.closeResources.bind(pool);
      let cleanupCalled = false;
      const cleanup = process.versions.bun
        ? vi.spyOn(pool, "rotate").mockImplementation(async () => {
            await rotate();
            cleanupCalled = true;
            invalidateRegisteredAgentDatabasesMemo({ env });
          })
        : vi.spyOn(pool, "closeResources").mockImplementation(async (key) => {
            await closeResources(key);
            cleanupCalled = true;
            invalidateRegisteredAgentDatabasesMemo({ env });
          });
      try {
        const pending =
          kind === "batch"
            ? readSessionEntriesFromStoreInWorker({
                agentId: "main",
                storePath,
                sessionKeys: [sessionKey],
                env,
              })
            : readExpiredCronRunEntriesInWorker({
                agentId: "main",
                storePath,
                env,
                updatedBefore: 2,
              });
        await expect(pending).rejects.toThrow("registry changed");
        expect(cleanupCalled).toBe(true);
      } finally {
        cleanup.mockRestore();
      }
    });
  },
);
