import { existsSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { sweepExpiredPluginStateEntries } from "../plugin-state/plugin-state-store.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withTaskRegistryTempDir } from "./task-registry.test-support.js";

it("drains worker-only state before removing a task fixture", async () => {
  let databasePath: string | undefined;
  let assertCurrent: (() => void) | undefined;
  let unregister: (() => void) | undefined;
  let cleanupFinished = false;
  let directoryPresentDuringCleanup = false;
  try {
    await withTaskRegistryTempDir(async (root) => {
      await sweepExpiredPluginStateEntries();
      const context = captureOpenClawStateWorkerContext();
      databasePath = context.admission.databasePath;
      assertCurrent = context.admission.assertCurrent;
      unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(identity) {
          if (identity?.canonicalPath === context.admission.identity.canonicalPath) {
            await Promise.resolve();
            directoryPresentDuringCleanup = existsSync(root);
            cleanupFinished = true;
          }
        },
      });
    });
    expect(cleanupFinished).toBe(true);
    expect(directoryPresentDuringCleanup).toBe(true);
    expect(expectDefined(assertCurrent, "expected the fixture read admission")).toThrow(
      "OpenClaw state database read admission changed",
    );
  } finally {
    unregister?.();
    if (databasePath) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
  }
});
