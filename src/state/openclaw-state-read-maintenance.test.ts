import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-errors.js";
import { isStateDatabaseMaintenanceContention } from "../infra/gateway-state-owner-record.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each([
  ["schema", StateDatabaseAdmissionPendingError],
  ["offline", StateDatabaseOfflineMaintenanceError],
] as const)(
  "preserves %s maintenance contention from the real read worker",
  async (kind, ErrorType) => {
    const root = directories.make("state-read-maintenance-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const options = { path: databasePath, env: { ...process.env, OPENCLAW_STATE_DIR: root } };
    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext(options);
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const owner = await source.captureIndependentResource(
      resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "openclaw-state-read-maintenance.test-support",
        distWorkerPath: "state/openclaw-state-read-maintenance.test-support.js",
      }),
      { databasePath, kind },
    );
    const transport = captureOpenClawStateReadSource().createTransport({ type: "nodeHost.config" });
    try {
      const holder = once(owner.port, "message");
      owner.port.postMessage("pid", []);
      expect((await holder)[0]).not.toBe(process.pid);
      const outcome = await transport.startRead(
        { context, location: databasePath, checkFreshAdmission: false },
        { signal: new AbortController().signal, assertCurrent: context.admission.assertCurrent },
      );
      expect(outcome).toHaveProperty("error");
      if (!("error" in outcome)) {
        throw new Error("Expected the foreign maintenance owner to refuse the worker read");
      }
      expect(outcome.error).toBeInstanceOf(ErrorType);
      expect(outcome.error).toMatchObject({ databasePath });
      expect(isStateDatabaseMaintenanceContention(outcome.error)).toBe(true);
    } finally {
      await owner.close();
      await transport.startClose();
    }
  },
);
