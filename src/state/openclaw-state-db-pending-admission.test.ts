import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("coalesces close custody while a sealed path is rebound to a replacement", async () => {
  const owner = createOpenClawStateDatabaseAsyncLifecycle();
  const file = path.join(dirs.make("pending-state-replacement-"), "state.sqlite");
  writeFileSync(file, "original");
  const admission = owner.capture(file);
  const finish = createDeferredCore();
  owner.register({ close: () => finish.promise });
  const closing = owner.close(file, () => false);
  try {
    renameSync(file, `${file}.retired`);
    writeFileSync(file, "replacement");
    const replacement = owner.publish(file);
    expect(replacement.key).not.toBe(admission.identity.key);
    expect(owner.close(file, () => false)).toBe(closing);
    expect(() => owner.capture(file)).toThrow(/admission is closed/);
  } finally {
    finish.resolve();
    await closing;
  }
  expect(admission.assertCurrent).toThrow(/admission changed/);
  const replacement = owner.capture(file);
  expect(replacement.identity.key).not.toBe(admission.identity.key);
  replacement.assertCurrent();
});

it("joins a shared resource registered during a pending close before native retirement", async () => {
  const owner = createOpenClawStateDatabaseAsyncLifecycle();
  const file = path.join(dirs.make("pending-state-owner-"), "state.sqlite");
  const admission = owner.capture(file);
  const firstClose = createDeferredCore();
  const firstEntered = createDeferredCore();
  const lateClose = createDeferredCore();
  const lateEntered = createDeferredCore();
  let retired = false;
  owner.register({
    close: async () => {
      firstEntered.resolve();
      await firstClose.promise;
    },
  });
  const closing = owner.close(file, () => {
    retired = true;
    return false;
  });
  try {
    await firstEntered.promise;
    owner.register({
      close: async () => {
        lateEntered.resolve();
        await lateClose.promise;
      },
    });
    expect(admission.assertCurrent).toThrow(/closed/u);
    firstClose.resolve();
    await Promise.race([lateEntered.promise, closing]);
    expect(retired).toBe(false);
    lateClose.resolve();
    await closing;
    expect(retired).toBe(true);
  } finally {
    firstClose.resolve();
    lateClose.resolve();
    await closing;
  }
});
