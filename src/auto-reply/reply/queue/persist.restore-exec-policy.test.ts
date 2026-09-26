import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  followupQueueEntryContainsPrompt,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  restoreFollowupQueues,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  createFollowupPersistTestRun as makeRun,
  readFollowupPersistQueueEntry as readPersistedQueueEntry,
} from "./persist.test-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";

describe("persistFollowupQueues restrictive exec policy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-persist-exec-");
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  async function restorePersistedQueueForTest() {
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    await restoreFollowupQueues();
  }

  it("persists and restores restrictive exec overlays", async () => {
    const run = makeRun();
    run.execOverrides = { host: "gateway", security: "deny", ask: "always" };
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("deny-always"), run });
    queue.lastRun = run;
    await persistFollowupQueues();

    const persisted = (await readPersistedQueueEntry(TEST_KEY)) as {
      items: Array<{ run: { execOverrides?: unknown } }>;
      lastRun?: { execOverrides?: unknown };
    };
    expect(persisted.items[0]?.run.execOverrides).toEqual({ security: "deny", ask: "always" });
    expect(persisted.lastRun?.execOverrides).toEqual({ security: "deny", ask: "always" });

    await restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.run.execOverrides).toEqual({ security: "deny", ask: "always" });
    expect(restored?.lastRun?.execOverrides).toEqual({ security: "deny", ask: "always" });
  });

  it("persists sandbox host and allowlist without elevation", async () => {
    const run = makeRun();
    run.execOverrides = { host: "sandbox", security: "allowlist", ask: "on-miss" };
    run.elevatedLevel = "full";
    run.bashElevated = { enabled: true, allowed: true, defaultLevel: "full" };
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("sandbox-allowlist"), run });
    await persistFollowupQueues();

    const persisted = (await readPersistedQueueEntry(TEST_KEY)) as {
      items: Array<{ run: Record<string, unknown> }>;
    };
    expect(persisted.items[0]?.run.execOverrides).toEqual({
      host: "sandbox",
      security: "allowlist",
      ask: "on-miss",
    });
    expect(persisted.items[0]?.run).not.toHaveProperty("elevatedLevel");
    expect(persisted.items[0]?.run).not.toHaveProperty("bashElevated");

    await restorePersistedQueueForTest();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run;
    expect(restored?.execOverrides).toEqual({
      host: "sandbox",
      security: "allowlist",
      ask: "on-miss",
    });
    expect(restored?.elevatedLevel).toBeUndefined();
    expect(restored?.bashElevated).toBeUndefined();
  });

  it("fail-closes discarded follow-ups instead of replaying them after restart", async () => {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("discarded-after-delivery-failure"),
      discarded: true,
    });
    await persistFollowupQueues();
    expect(
      await followupQueueEntryContainsPrompt(TEST_KEY, "discarded-after-delivery-failure"),
    ).toBe(true);

    const persisted = (await readPersistedQueueEntry(TEST_KEY)) as {
      items: Array<{ prompt?: string; discarded?: true; delivered?: true }>;
    };
    expect(persisted.items[0]?.discarded).toBe(true);
    expect(persisted.items[0]?.delivered).toBeUndefined();

    await restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(
      await followupQueueEntryContainsPrompt(TEST_KEY, "discarded-after-delivery-failure"),
    ).toBe(false);
  });

  it("fail-closes invalid persisted exec overrides", async () => {
    const validRun = makeRun();
    await replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "bogus-exec",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  execOverrides: { security: "bogus" },
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
    await restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "bogus-exec")).toBe(false);
  });
});
