import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  type DatabaseProcessRole,
} from "./admission-scope.js";

function probe(role?: DatabaseProcessRole) {
  if (role) {
    installDatabaseProcessRole(role);
    installDatabaseProcessRole(role);
  }
  let allowed = false;
  try {
    assertEngineStoreExecutionAllowed();
    allowed = true;
  } catch {
    // Report refusal through the subprocess boundary.
  }
  let changeRefused = false;
  if (role) {
    try {
      installDatabaseProcessRole(role === "gateway" ? "cli-oneshot" : "gateway");
    } catch {
      changeRefused = true;
    }
  }
  return { allowed, changeRefused };
}

async function probeMaintenance() {
  assert.throws(assertEngineStoreExecutionAllowed, /must run in a worker/);
  let expired = false;
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {
      if (expired) {
        throw new Error("maintenance owner expired");
      }
    },
  });
  const captured = await scope.run(async () => {
    await Promise.resolve();
    assert.doesNotThrow(assertEngineStoreExecutionAllowed);
    expired = true;
    assert.throws(assertEngineStoreExecutionAllowed, /maintenance owner expired/);
    expired = false;
    return AsyncLocalStorage.snapshot();
  });
  await scope.close();
  assert.throws(() => captured(assertEngineStoreExecutionAllowed), /scope is closed/);
  const configOnly = createOpenClawDatabaseMaintenanceScope({ schemaMaintenance: false });
  try {
    configOnly.run(() => assert.throws(assertEngineStoreExecutionAllowed, /must run in a worker/));
  } finally {
    await configOnly.close();
  }
  assert.throws(assertEngineStoreExecutionAllowed, /must run in a worker/);
}

async function probeMain(role?: DatabaseProcessRole, maintenance = false) {
  const result = probe(role);
  if (maintenance) {
    await probeMaintenance();
  }
  let gatewayRefused: boolean | undefined;
  if (role === "cli-oneshot") {
    const { startGatewayServer } = await import("../../gateway/server.js");
    try {
      await startGatewayServer();
      gatewayRefused = false;
    } catch (error) {
      gatewayRefused = error instanceof Error && error.message.includes("cannot become gateway");
    }
  }
  process.send?.({ ...result, ...(gatewayRefused === undefined ? {} : { gatewayRefused }) });
  process.disconnect?.();
}

if (isMainThread) {
  process.once(
    "message",
    ({ role, maintenance }: { role?: DatabaseProcessRole; maintenance?: boolean }) => {
      void probeMain(role, maintenance);
    },
  );
} else {
  parentPort?.postMessage(probe(workerData?.role), []);
}
