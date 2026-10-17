import { existsSync, unlinkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "./openclaw-state.worker.js";

// mock-isolation: Throw on import to detect eager loading of unrelated secret commands.
vi.mock("../secrets/store/secret-store.worker.js", () => {
  throw new Error("Cold preparation must not load secret-store commands");
});
// mock-isolation: Throw on import to detect eager loading of unrelated cron commands.
vi.mock("../cron/store/dispatch.worker.js", () => {
  throw new Error("Cold preparation must not load cron commands");
});
// mock-isolation: Throw on import to detect eager loading of unrelated updater commands.
vi.mock("../infra/update-run-dispatch.worker.js", () => {
  throw new Error("Cold preparation must not load updater commands");
});

it.each([
  "restartLifecycle.consumeIntent",
  "restartLifecycle.writeHandoff",
  "sessionUpstream.listWatched",
] as const)(
  "prepares cold %s without application commands or database access",
  async (commandType) => {
    await withOpenClawTestState({ label: "state-lazy-preparation" }, async () => {
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
        expect(backend[SQLITE_WORKER_PREPARE_COMMAND]).toBeTypeOf("function");
        await backend[SQLITE_WORKER_PREPARE_COMMAND]?.(commandType);
        expect(existsSync(databasePath)).toBe(false);
      } finally {
        await backend.close();
      }
    });
  },
);

it("keeps shared-state and session-upstream workers independent of host runtime discovery", () => {
  expect(
    findSourceImportBackedges(
      ["src/state/openclaw-state.worker.ts", "src/sessions/session-upstream-links.worker.ts"],
      [
        "src/config/io.snapshot.ts",
        "src/config/validation-core.ts",
        "src/plugins/loader-runtime-load.ts",
        "src/channels/plugins/registry.ts",
        "packages/gateway-protocol/src/validator-registry.ts",
      ],
    ),
  ).toEqual([]);
});

it.each([
  {
    type: "pluginState.clearRuntimeHealth",
    input: {
      pluginId: "lazy-fixture",
      namespace: "missing",
      processId: 1,
      selection: { kind: "context-engine" },
    },
  },
  { type: "deviceAuth.prepare", input: undefined },
  { type: "plugins.deferredMigrations.read", input: { artifactPreservingReadOnly: true } },
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
        // A Promise tells the transport to flush newly loaded compile-cache entries.
        expect(backend[SQLITE_WORKER_PREPARE_COMMAND]?.(command.type)).toBeUndefined();
        expect(runWithSqliteWorkerStateContext(context, () => backend.execute(command))).toEqual(
          command.type === "pluginState.clearRuntimeHealth"
            ? { ok: true, value: undefined }
            : command.type === "plugins.deferredMigrations.read"
              ? []
              : undefined,
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
