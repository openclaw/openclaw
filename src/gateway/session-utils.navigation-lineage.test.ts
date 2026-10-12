/** Tests persisted navigation lineage independently of live subagent control. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { listSessionFixture } from "./session-list.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

describe("session list navigation lineage", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    await resetSubagentRegistryForTests({ persist: false });
  });
  beforeEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await resetSubagentRegistryForTests({ persist: false });
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { entries: { main: {} } },
  } as OpenClawConfig;

  test.each(["idle", "fork", "visible spawn"] as const)(
    "keeps persistent dashboard navigation beyond run retention (%s)",
    async (kind) => {
      const storePath = path.join(tempDirs.make("session-navigation-retention-"), "sessions.json");
      const now = Date.UTC(2026, 8, 26, 12);
      const old = now - 2 * 60 * 60_000;
      const parentKey = "agent:main:dashboard:parent";
      const controllerKey = "agent:main:subagent:controller";
      const childKey = "agent:main:dashboard:child";
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const childEntry: SessionEntry = {
        sessionId: "child",
        updatedAt: kind === "fork" ? now - 1_000 : old,
        parentSessionKey: parentKey,
        parentSessionId: "parent",
        ...(kind === "fork"
          ? {
              status: "done",
              endedAt: old,
              forkSource: { sessionKey: parentKey, sessionId: "parent" },
            }
          : {}),
        ...(kind === "visible spawn" ? { spawnedBy: controllerKey, spawnDepth: 1 } : {}),
      };
      const store: Record<string, SessionEntry> = {
        [parentKey]: { sessionId: "parent", updatedAt: now },
        [controllerKey]: { sessionId: "controller", updatedAt: now },
        [childKey]: childEntry,
      };
      try {
        if (kind === "visible spawn") {
          seedSubagentRunForReadTest({
            runId: "completed-visible-spawn",
            childSessionKey: childKey,
            requesterSessionKey: controllerKey,
            requesterDisplayKey: "controller",
            task: "persistent conversation",
            cleanup: "keep",
            createdAt: old - 2_000,
            startedAt: old - 1_000,
            endedAt: old,
            outcome: { status: "ok" },
          });
        }
        const list = (spawnedBy?: string) =>
          listSessionFixture({ cfg, storePath, store, opts: { spawnedBy } });
        const all = await list();
        expect(all.sessions.find((row) => row.key === childKey)?.parentSessionKey).toBe(parentKey);
        expect(all.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([
          childKey,
        ]);
        expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
        // Navigation persists; a completed delegation does not retain runtime ownership.
        expect(
          all.sessions.find((row) => row.key === controllerKey)?.childSessions,
        ).toBeUndefined();
        expect((await list(controllerKey)).sessions).toEqual([]);
        childEntry.archivedAt = now;
        expect((await list(parentKey)).sessions).toEqual([]);
        delete childEntry.archivedAt;
        expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);
      } finally {
        clock.mockRestore();
      }
    },
  );
});
