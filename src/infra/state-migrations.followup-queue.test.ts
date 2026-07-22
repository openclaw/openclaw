// Covers doctor migration of the retired live-chat-followup-queues.json sidecar.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { loadFollowupQueueEntries, replaceFollowupQueueEntries } from "./followup-queue-sqlite.js";
import {
  detectLegacyFollowupQueueSidecar,
  migrateLegacyFollowupQueueSidecar,
} from "./state-migrations.followup-queue.js";

describe("legacy followup queue sidecar doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      vi.restoreAllMocks();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  async function useStateDir(): Promise<string> {
    const stateDir = tempDirs.make("openclaw-followup-queue-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  async function writeLegacySidecar(stateDir: string, body: unknown): Promise<string> {
    const sourcePath = path.join(stateDir, "live-chat-followup-queues.json");
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify(body), "utf8");
    return sourcePath;
  }

  it("detects a legacy followup queue JSON sidecar", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacySidecar(stateDir, { version: 1, entries: [] });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    expect(detected.hasLegacy).toBe(true);
    expect(detected.sourcePath).toBe(sourcePath);
  });

  it("migrates legacy followup queue entries into shared SQLite state", async () => {
    const stateDir = await useStateDir();
    const queueKey = "agent:main:dm:migration-test";
    const sourcePath = await writeLegacySidecar(stateDir, {
      version: 1,
      updatedAt: 100,
      entries: [
        [
          queueKey,
          {
            items: [
              {
                prompt: "doctor migrated prompt",
                enqueuedAt: 100,
                originatingChannel: "telegram",
                originatingTo: "999",
                run: {
                  agentId: "main",
                  sessionId: "sess-migrate",
                  sessionKey: queueKey,
                  provider: "anthropic",
                  model: "claude",
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 100,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    expect(detected.hasLegacy).toBe(true);

    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 followup queue entry → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);

    const entries = loadFollowupQueueEntries(stateDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe(queueKey);
    const queueData = entries[0]?.[1] as {
      items?: Array<{ prompt?: string; originatingChannel?: string }>;
    };
    expect(queueData.items?.[0]?.prompt).toBe("doctor migrated prompt");
    expect(queueData.items?.[0]?.originatingChannel).toBe("telegram");
  });

  it("removes an empty legacy sidecar without importing rows", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacySidecar(stateDir, { version: 1, entries: [] });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.changes).toContain(`Removed empty followup queue sidecar ${sourcePath}`);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(loadFollowupQueueEntries(stateDir)).toEqual([]);
  });

  it("keeps the legacy sidecar when shared SQLite already has conflicting data", async () => {
    const stateDir = await useStateDir();
    const queueKey = "agent:main:dm:conflict";
    replaceFollowupQueueEntries({
      stateDir,
      entries: [
        [
          queueKey,
          {
            items: [{ prompt: "already in sqlite", enqueuedAt: 1, run: { agentId: "main" } }],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    const sourcePath = await writeLegacySidecar(stateDir, {
      version: 1,
      entries: [
        [
          queueKey,
          {
            items: [{ prompt: "stale json prompt", enqueuedAt: 2, run: { agentId: "main" } }],
            mode: "steer",
            lastEnqueuedAt: 2,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.warnings).toContain(
      "Left followup queue sidecar in place because 1 entry already existed in shared state with different data: agent:main:dm:conflict",
    );
    await expect(fsp.readFile(sourcePath, "utf8")).resolves.toContain("stale json prompt");
    const entries = loadFollowupQueueEntries(stateDir);
    expect(entries).toHaveLength(1);
    const sqliteQueue = entries[0]?.[1] as { items?: Array<{ prompt?: string }> };
    expect(sqliteQueue.items?.[0]?.prompt).toBe("already in sqlite");
  });

  it("is a no-op when no legacy sidecar exists", async () => {
    const stateDir = await useStateDir();
    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    expect(detected.hasLegacy).toBe(false);

    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });
    expect(result).toStrictEqual({ changes: [], warnings: [] });
  });
});
