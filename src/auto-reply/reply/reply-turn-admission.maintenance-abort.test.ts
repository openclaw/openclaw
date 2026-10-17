// Tests that a caller Stop during the foreground maintenance wait ends only
// the reply admission, never the maintenance writer's tracked completion.
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
});

// Bounded so an uncancellable wait fails here instead of hanging the shard.
it(
  "skips an aborted reply waiting on maintenance without ending its cleanup",
  { timeout: 10_000 },
  async () => {
    const sessionKey = "agent:main:telegram:topic:maintenance-abort";
    const sessionId = "session-before-maintenance-abort";
    const storePath = path.join(tempDirs.make("maintenance-abort-admission-"), "sessions.json");
    replaceSessionEntrySync({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    const releaseCleanup = createDeferred();
    let cleanupFinished = false;
    const owner = createSessionMaintenanceOwner({ sessionKey });
    const cleanup = owner.track(
      owner.run(async () => {
        await releaseCleanup.promise;
        cleanupFinished = true;
      }),
    );
    const controller = new AbortController();
    const admission = admitReplyTurn({
      kind: "visible",
      resetTriggered: false,
      sessionKey,
      sessionId,
      storePath,
      upstreamAbortSignal: controller.signal,
    });
    controller.abort();

    await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
    // The writer keeps its own tracked completion across the caller's Stop.
    expect(cleanupFinished).toBe(false);
    expect(owner.signal.aborted).toBe(false);
    releaseCleanup.resolve();
    await cleanup;
    await owner.done;
    expect(cleanupFinished).toBe(true);
  },
);
