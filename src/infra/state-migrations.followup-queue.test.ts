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

function makeRestorableRun(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "main",
    sessionId: "sess-migrate",
    sessionFile: "/tmp/sess.jsonl",
    workspaceDir: "/tmp/ws",
    provider: "anthropic",
    model: "claude",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
    ...overrides,
  };
}

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
                run: makeRestorableRun({ sessionId: "sess-migrate", sessionKey: queueKey }),
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
            items: [
              {
                prompt: "already in sqlite",
                enqueuedAt: 1,
                run: makeRestorableRun({ sessionId: "sess-existing" }),
              },
            ],
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
            items: [
              {
                prompt: "stale json prompt",
                enqueuedAt: 2,
                run: makeRestorableRun({ sessionId: "sess-sidecar" }),
              },
            ],
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

  it("retains the sidecar when an entry fails the full restore contract", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacySidecar(stateDir, {
      version: 1,
      entries: [
        [
          "agent:main:dm:incomplete",
          {
            items: [
              {
                prompt: "incomplete run fields",
                enqueuedAt: 1,
                run: {
                  agentId: "main",
                  sessionId: "sess-incomplete",
                  provider: "anthropic",
                  model: "claude",
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.warnings).toContain(
      `Left followup queue sidecar in place because one or more entries failed the full restore contract: ${sourcePath}`,
    );
    expect(result.changes).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(loadFollowupQueueEntries(stateDir)).toStrictEqual([]);
  });

  it("retains the sidecar when items are malformed rather than deleting as empty", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacySidecar(stateDir, {
      version: 1,
      entries: [["agent:main:dm:bad", { items: [{ prompt: 7, run: {} }] }]],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.warnings).toContain(
      `Left followup queue sidecar in place because one or more entries failed the full restore contract: ${sourcePath}`,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(loadFollowupQueueEntries(stateDir)).toStrictEqual([]);
  });

  it("retains the sidecar when summarySources fail session/route deliverability", async () => {
    const stateDir = await useStateDir();
    const queueKey = "agent:main:dm:summary-source-bad";
    const sourcePath = await writeLegacySidecar(stateDir, {
      version: 1,
      entries: [
        [
          queueKey,
          {
            items: [
              {
                prompt: "ok item",
                enqueuedAt: 1,
                originatingChannel: "telegram",
                originatingTo: "999",
                run: makeRestorableRun({ sessionKey: queueKey }),
              },
            ],
            summarySources: [
              {
                prompt: "overflow with incomplete route",
                enqueuedAt: 2,
                originatingChannel: "telegram",
                run: makeRestorableRun({ sessionKey: queueKey }),
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 2,
            droppedCount: 1,
            summaryLines: ["overflow with incomplete route"],
          },
        ],
      ],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });

    expect(result.warnings).toContain(
      `Left followup queue sidecar in place because one or more entries failed the full restore contract: ${sourcePath}`,
    );
    expect(result.changes).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(loadFollowupQueueEntries(stateDir)).toStrictEqual([]);
  });

  it("is a no-op when no legacy sidecar exists", async () => {
    const stateDir = await useStateDir();
    const detected = detectLegacyFollowupQueueSidecar({ stateDir });
    expect(detected.hasLegacy).toBe(false);

    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir });
    expect(result).toStrictEqual({ changes: [], warnings: [] });
  });

  it("migrates into an explicit stateDir even when OPENCLAW_STATE_DIR points elsewhere", async () => {
    const envStateDir = await useStateDir();
    const selectedDir = tempDirs.make("openclaw-followup-queue-migration-selected-");
    await fsp.mkdir(selectedDir, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", envStateDir);

    const sourcePath = await writeLegacySidecar(selectedDir, {
      version: 1,
      entries: [
        [
          "agent:main:dm:selected-dir",
          {
            items: [
              {
                prompt: "selected-dir-followup",
                enqueuedAt: 42,
                run: makeRestorableRun({ sessionId: "sess-selected" }),
              },
            ],
            mode: "steer",
            debounceMs: 500,
            cap: 20,
            dropPolicy: "summarize",
          },
        ],
      ],
    });

    const detected = detectLegacyFollowupQueueSidecar({ stateDir: selectedDir });
    expect(detected.hasLegacy).toBe(true);
    const result = await migrateLegacyFollowupQueueSidecar({ detected, stateDir: selectedDir });
    expect(result.warnings).toEqual([]);
    expect(result.changes.some((change) => change.includes("Migrated 1"))).toBe(true);
    await expect(fsp.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(loadFollowupQueueEntries(selectedDir)).toEqual([
      [
        "agent:main:dm:selected-dir",
        expect.objectContaining({
          items: [expect.objectContaining({ prompt: "selected-dir-followup" })],
        }),
      ],
    ]);
    expect(loadFollowupQueueEntries(envStateDir)).toEqual([]);
  });
});
