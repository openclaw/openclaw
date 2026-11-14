import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

it("prepares cold and warm plugin handlers and rejects missing exports before database access", async () => {
  await withOpenClawTestState({ label: "plugin-operation-preparation" }, async () => {
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
    const modulePath = fileURLToPath(
      new URL("../plugin-state/plugin-state-operation.test-support.ts", import.meta.url),
    );
    const command = {
      type: "pluginState.executeOperation",
      input: {
        module: {
          modulePath,
          boundaryRoot: path.dirname(modulePath),
          origin: "bundled",
          pluginId: "preparation-test",
        },
        exportName: "execute",
        stores: [],
        writeStores: [],
        command: { type: "read", input: { store: 0, key: "key" } },
        receiptId: "preparation-test",
      },
    } as const;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const preparation = backend.prepare?.(command);
        expect(preparation).toBeInstanceOf(Promise);
        await preparation;
        expect(existsSync(databasePath)).toBe(false);
      }
      await expect(
        backend.prepare?.({
          ...command,
          input: { ...command.input, exportName: "missingHandler" },
        }),
      ).rejects.toThrow("Plugin state operation module must export a synchronous handler");
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      await backend.close();
    }
  });
});

it.each([
  "restartLifecycle.consumeIntent",
  "restartLifecycle.writeHandoff",
  "sessionUpstream.listWatched",
  "githubPublication.sourceFacts",
  "githubPublications.repository",
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
        expect(backend[SQLITE_WORKER_PREPARE_COMMAND]?.(commandType)).toBeUndefined();
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
      [
        "src/state/openclaw-state.worker.ts",
        "src/sessions/session-upstream-links.worker.ts",
        // Loaded lazily by the shared-state worker; dynamic imports are separate entries.
        "src/infra/update-run-dispatch.worker.ts",
      ],
      [
        "src/config/io.snapshot.ts",
        "src/config/validation-core.ts",
        "src/plugins/loader-runtime-load.ts",
        "src/channels/plugins/registry.ts",
        "packages/gateway-protocol/src/validator-registry.ts",
        // Update-result policy and network dispatch belong to the host owner.
        "src/infra/update-result-telemetry.ts",
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
        expect(backend.prepare?.(command)).toBeUndefined();
        expect(runWithSqliteWorkerStateContext(context, () => backend.execute(command))).toEqual(
          command.type === "pluginState.clearRuntimeHealth" ? { ok: true, value: undefined } : [],
        );
        expect(existsSync(databasePath)).toBe(false);
      } finally {
        await backend.close();
      }
    });
  },
);
