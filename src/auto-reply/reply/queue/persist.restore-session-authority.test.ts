import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { followupQueueEntryContainsPrompt } from "../../../infra/followup-queue-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  persistFollowupQueues,
  restoreFollowupQueues,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  createFollowupPersistTestRun as makeRun,
} from "./persist.test-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

describe("restored follow-up session authority revalidation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-session-authority-state-");
    storePath = path.join(tempDirs.make("openclaw-session-authority-store-"), "sessions.json");
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot({ session: { store: storePath } } as OpenClawConfig);
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  function seedSessionEntry(entry: Partial<SessionEntry>): void {
    replaceSessionEntrySync(
      { storePath, sessionKey: TEST_KEY },
      { sessionId: "sess-persist", updatedAt: 1, ...entry },
    );
  }

  async function persistQueuedTurn(prompt: string, run: FollowupRun["run"]): Promise<void> {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun(prompt), run });
    await persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
  }

  it("restores a turn whose session authority still matches the live entry", async () => {
    seedSessionEntry({ permissionMode: "workspace", sessionRoot: "/tmp/workspace/project" });
    const run = makeRun();
    run.permissionMode = "workspace";
    run.sessionRoot = "/tmp/workspace/project";
    await persistQueuedTurn("still-scoped", run);

    await restoreFollowupQueues();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "still-scoped",
    ]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "still-scoped")).toBe(true);
  });

  it("re-reports authority that tightens after restore but before the drain", async () => {
    // Restore compares once. The queue drains on a later wake, so a session
    // tightened in between must still be caught before execution — and the
    // restore-time read is memoized, so the re-check has to read fresh.
    seedSessionEntry({ permissionMode: "workspace", sessionRoot: "/tmp/workspace/project" });
    const run = makeRun();
    run.permissionMode = "workspace";
    run.sessionRoot = "/tmp/workspace/project";
    await persistQueuedTurn("tightened-after-restore", run);

    await restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.prompt).toBe("tightened-after-restore");
    expect(restored?.restoredSessionAuthorityChanged?.()).toBe(false);

    seedSessionEntry({ permissionMode: "read-only", sessionRoot: "/tmp/workspace/project" });

    expect(restored?.restoredSessionAuthorityChanged?.()).toBe(true);
  });

  it("fail-closes a turn whose session permission mode tightened while it waited", async () => {
    seedSessionEntry({ permissionMode: "workspace", sessionRoot: "/tmp/workspace/project" });
    const run = makeRun();
    run.permissionMode = "workspace";
    run.sessionRoot = "/tmp/workspace/project";
    await persistQueuedTurn("stale-mode", run);
    seedSessionEntry({ permissionMode: "read-only", sessionRoot: "/tmp/workspace/project" });

    await restoreFollowupQueues();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "stale-mode")).toBe(false);
  });

  it("fail-closes a turn whose session root moved while it waited", async () => {
    seedSessionEntry({ permissionMode: "workspace", sessionRoot: "/tmp/workspace/project" });
    const run = makeRun();
    run.permissionMode = "workspace";
    run.sessionRoot = "/tmp/workspace/project";
    await persistQueuedTurn("stale-root", run);
    seedSessionEntry({ permissionMode: "workspace", sessionRoot: "/tmp/workspace/other" });

    await restoreFollowupQueues();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "stale-root")).toBe(false);
  });

  it("fail-closes a turn whose session tool overrides changed while it waited", async () => {
    seedSessionEntry({ toolOverrides: { skills: { research: true } } });
    const run = makeRun();
    run.toolOverrides = { skills: { research: true } };
    await persistQueuedTurn("stale-overrides", run);
    seedSessionEntry({ toolOverrides: { skills: { research: false } } });

    await restoreFollowupQueues();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "stale-overrides")).toBe(false);
  });

  it("leaves a session with no live entry to execution admission", async () => {
    const run = makeRun();
    await persistQueuedTurn("no-live-entry", run);

    await restoreFollowupQueues();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "no-live-entry",
    ]);
  });
});
