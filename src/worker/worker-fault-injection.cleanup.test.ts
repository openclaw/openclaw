import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { ComposedGatewayHarness } from "./worker-fault-injection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function cleanupOptions(root: string) {
  return { stateDir: path.join(root, "state"), rootPath: root };
}

describe("composed worker Gateway fixture cleanup", () => {
  it("joins owned agent resources before removal without closing sibling databases", async () => {
    const root = tempDirs.make("oc-wfc-");
    const siblingRoot = tempDirs.make("oc-wfc-sibling-");
    const entered = createDeferred();
    const release = createDeferred();
    const revoke = vi.fn();
    const siblingRevoke = vi.fn();
    let resourceClosed = false;
    let harness: ComposedGatewayHarness | undefined;
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let unregisterSibling: (() => void) | undefined;
    try {
      harness = await ComposedGatewayHarness.create(root);
      await harness.start();
      const siblingEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: cleanupOptions(siblingRoot).stateDir,
      };
      const siblingAgent = openOpenClawAgentDatabase({
        agentId: "main",
        env: siblingEnv,
        path: path.join(siblingRoot, "agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      const siblingState = openOpenClawStateDatabase({ env: siblingEnv });
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
        revoke,
        close: async () => {
          entered.resolve();
          await release.promise;
          resourceClosed = true;
        },
      });
      unregisterSibling = registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: siblingAgent.path,
        revoke: siblingRevoke,
        close: async () => {},
      });

      closing = harness.close();
      // A missing drain settles close first, so the regression fails without a timer.
      const first = await Promise.race([
        entered.promise.then(() => "draining"),
        closing.then(
          () => "closed",
          () => "rejected",
        ),
      ]);
      expect(first).toBe("draining");
      expect(revoke).toHaveBeenCalledOnce();
      expect(resourceClosed).toBe(false);
      expect(existsSync(root)).toBe(true);
      expect(harness.database.db.isOpen).toBe(true);
      expect(siblingRevoke).not.toHaveBeenCalled();
      expect(siblingAgent.db.isOpen).toBe(true);
      expect(siblingState.db.isOpen).toBe(true);

      release.resolve();
      await closing;
      expect(resourceClosed).toBe(true);
      expect(existsSync(root)).toBe(false);
      expect(harness.database.db.isOpen).toBe(false);
      expect(siblingRevoke).not.toHaveBeenCalled();
      expect(siblingAgent.db.isOpen).toBe(true);
      expect(siblingState.db.isOpen).toBe(true);
      expect(existsSync(siblingRoot)).toBe(true);
    } finally {
      release.resolve();
      closing ??= harness?.close();
      await closing?.catch(() => undefined);
      await cleanupSessionStateForTest(cleanupOptions(root));
      await cleanupSessionStateForTest(cleanupOptions(siblingRoot));
      unregister?.();
      unregisterSibling?.();
    }
  });

  it("retains the fixture and propagates a resource retirement failure", async () => {
    const root = tempDirs.make("oc-wfc-r-");
    const failure = new Error("fixture resource retirement failed");
    let fail = true;
    let harness: ComposedGatewayHarness | undefined;
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    try {
      harness = await ComposedGatewayHarness.create(root);
      await harness.start();
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
        revoke: () => {},
        close: async () => {
          if (fail) {
            throw failure;
          }
        },
      });

      closing = harness.close();
      await expect(closing).rejects.toMatchObject({
        name: "AggregateError",
        errors: expect.arrayContaining([failure]),
      });
      expect(existsSync(root)).toBe(true);
      expect(harness.database.db.isOpen).toBe(true);
    } finally {
      fail = false;
      closing ??= harness?.close();
      await closing?.catch(() => undefined);
      await cleanupSessionStateForTest(cleanupOptions(root));
      unregister?.();
    }
  });
});
