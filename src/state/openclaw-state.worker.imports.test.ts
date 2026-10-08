import { existsSync, unlinkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "./openclaw-state.worker.js";

vi.mock("./openclaw-state-worker-runtime.js", () => {
  throw new Error("Plugin-state preparation must not load unrelated shared-state commands");
});

it("keeps the shared-state command worker independent of host runtime discovery", () => {
  expect(
    findSourceImportBackedges("src/state/openclaw-state-worker-runtime.ts", [
      "src/config/io.snapshot.ts",
      "src/config/validation-core.ts",
      "src/plugins/loader-runtime-load.ts",
      "src/channels/plugins/registry.ts",
      "packages/gateway-protocol/src/validator-registry.ts",
    ]),
  ).toEqual([]);
});

it.each([
  {
    type: "pluginState.lookup",
    input: { pluginId: "lazy-fixture", namespace: "missing", key: "value" },
  },
  { type: "deviceAuth.prepare", input: undefined },
] as const)(
  "prepares cold $type without unrelated commands or creating a database",
  async (command) => {
    await withOpenClawTestState({ label: "plugin-state-lazy-preparation" }, async () => {
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
        expect(existsSync(databasePath)).toBe(false);
        await backend[SQLITE_WORKER_PREPARE_COMMAND]?.(command.type);
        expect(runWithSqliteWorkerStateContext(context, () => backend.execute(command))).toEqual(
          command.type === "pluginState.lookup" ? { ok: true, value: undefined } : undefined,
        );
        if (command.type === "deviceAuth.prepare") {
          expect(
            runWithSqliteWorkerStateContext(context, () =>
              backend.execute({
                type: "deviceAuth.readOrigin",
                input: {
                  deviceId: "synthetic-device",
                  role: "operator",
                  gatewayScope: "wss://synthetic.example",
                  readOnly: true,
                },
              }),
            ),
          ).toEqual({ entry: null, expectedToken: null });
        }
        expect(existsSync(databasePath)).toBe(false);
      } finally {
        await backend.close();
      }
    });
  },
);
