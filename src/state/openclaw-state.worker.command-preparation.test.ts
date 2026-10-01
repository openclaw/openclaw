import { existsSync, unlinkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "./openclaw-state.worker.js";

const { loadCron } = vi.hoisted(() => ({ loadCron: vi.fn() }));
vi.mock("../cron/store/dispatch.worker.js", async (importOriginal) => {
  loadCron();
  return await importOriginal();
});

it("prepares connect families independently without loading Cron", async () => {
  await withOpenClawTestState({ label: "connect-command-preparation" }, async () => {
    const databasePath = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext();
    const backend = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, {
        databasePath,
        existingIdentity: context.admission.identity.key,
      }),
    );
    unlinkSync(databasePath);
    try {
      for (const type of [
        "devicePairing.request",
        "devicePairing.ensureToken",
        "userProfiles.ensureOwner",
      ] as const) {
        await backend[SQLITE_WORKER_PREPARE_COMMAND]?.(type);
      }
      expect(loadCron).not.toHaveBeenCalled();
      expect(() =>
        runWithSqliteWorkerStateContext(context, () =>
          backend.execute({ type: "deviceAuth.prepare", input: undefined }),
        ),
      ).toThrow("not prepared");
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("deviceAuth.prepare");
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          backend.execute({ type: "deviceAuth.prepare", input: undefined }),
        ),
      ).toBeUndefined();
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          backend.execute({
            type: "deviceAuth.read",
            input: { deviceId: "synthetic-device", role: "operator", readOnly: true },
          }),
        ),
      ).toEqual({ entry: null, expectedToken: null });
      expect(existsSync(databasePath)).toBe(false);
      expect(loadCron).not.toHaveBeenCalled();
    } finally {
      await backend.close();
    }
  });
});
