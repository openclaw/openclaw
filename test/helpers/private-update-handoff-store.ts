import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { resolveServiceManagerEnv } from "../../src/daemon/service-process-env.js";
import * as temporaryRoot from "../../src/infra/tmp-openclaw-dir.js";
import * as managedHandoff from "../../src/infra/update-managed-service-handoff-lease.js";
export { writePrivateUpdateHandoffChildGuard } from "./private-update-handoff-child-guard.js";

export function installPrivateUpdateHandoffStore(directory: string) {
  const privateDirectory = fs.realpathSync(directory);
  const databasePath = path.join(privateDirectory, "managed-update-handoffs.sqlite");
  const assertDatabasePath = (actual: string) => {
    assert.equal(path.isAbsolute(actual), true);
    assert.equal(path.resolve(actual), databasePath);
    assert.equal(fs.realpathSync(path.dirname(actual)), privateDirectory);
    assert.notEqual(actual, "/tmp/openclaw/managed-update-handoffs.sqlite");
    assert.notEqual(actual, "/private/tmp/openclaw/managed-update-handoffs.sqlite");
    if (fs.existsSync(actual)) {
      assert.equal(fs.realpathSync(actual), databasePath);
    }
  };
  assertDatabasePath(databasePath);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateDirectory);
  vi.spyOn(managedHandoff, "resolveManagedUpdateLeaseDatabasePath").mockReturnValue(databasePath);
  const createStore = managedHandoff.createManagedHandoffLeaseStore;
  vi.spyOn(managedHandoff, "createManagedHandoffLeaseStore").mockImplementation(
    (options, logger) => {
      const selected = options ?? { databasePath, serviceManagerEnv: resolveServiceManagerEnv() };
      assertDatabasePath(selected.databasePath);
      return createStore(selected, logger);
    },
  );
  return { databasePath, assertDatabasePath };
}
