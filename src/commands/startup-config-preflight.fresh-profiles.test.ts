import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  readMacNodeWorkerProofRows,
  seedMacNodeWorkerProofState,
} from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { readDaemonRuntimePinMigrationPending } from "../daemon/runtime-pin-state.js";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import {
  closeOpenClawStateDatabaseAsync,
  prepareOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { setupCommand } from "./setup.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const producers = ["gateway", "baseline setup", "non-interactive setup"] as const;
async function createProfile(creation: (typeof producers)[number], state: OpenClawTestState) {
  if (creation === "baseline setup") {
    await setupCommand({ workspace: state.workspaceDir, skipBootstrap: true }, createTestRuntime());
  } else if (creation === "non-interactive setup") {
    await runNonInteractiveSetup(
      {
        workspace: state.workspaceDir,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipUi: true,
        skipHooks: true,
        skipBootstrap: true,
      },
      createTestRuntime(),
    );
  } else {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
  }
}

it.each([...producers, "native bootstrap"] as const)(
  "creates %s profiles without pending runtime-pin migration before the Gateway serves",
  async (creation) => {
    await withOpenClawTestState({ label: "fresh-runtime-pins" }, async (state) => {
      await createProfile(creation === "native bootstrap" ? "gateway" : creation, state);
      if (creation === "native bootstrap") {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const nativeRows = seedMacNodeWorkerProofState(databasePath);
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
        });
        expect(maintenance).toBeDefined();
        try {
          const migrated = await maintenance!.run(() =>
            prepareOpenClawStateDatabaseSchema({ env: state.env }, "doctor"),
          );
          expect(migrated.warnings).toEqual([]);
        } finally {
          await maintenance!.release();
        }
        await closeOpenClawStateDatabaseAsync();
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(
            readMacNodeWorkerProofRows(database, resolveClientCredentialStorePath(state.env)),
          ).toEqual(nativeRows);
        } finally {
          database.close();
        }
      } else if (creation !== "gateway") {
        // Setup must complete its own profile, even before the first Gateway start.
        expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(false);
      }
      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(ready.snapshot.valid).toBe(true);
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(false);

      const owner = await acquireGatewayLock({ allowInTests: true, env: state.env, timeoutMs: 0 });
      expect(owner).not.toBeNull();
      try {
        expect(await migrateDaemonRuntimePins(state.env)).toEqual({ changes: [], warnings: [] });
        owner?.assertCurrent();
      } finally {
        await owner?.release();
      }
    });
  },
);

it.each(producers)("keeps legacy runtime pins pending through %s", async (creation) => {
  await withOpenClawTestState({ label: "legacy-runtime-pins" }, async (state) => {
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
          .run("daemon-runtime-pin:legacy", '{"version":1,"runtime":"node"}', 123),
      { env: state.env },
    );
    await createProfile(creation, state);
    await runStartupConfigPreflight({ gateway: true, observe: false });
    expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
    const owner = await acquireGatewayLock({ allowInTests: true, env: state.env, timeoutMs: 0 });
    try {
      expect((await migrateDaemonRuntimePins(state.env)).warnings).toEqual([
        expect.stringContaining("Stop the Gateway"),
      ]);
    } finally {
      await owner?.release();
    }
    expect((await migrateDaemonRuntimePins(state.env)).changes).toEqual([
      "Moved 1 daemon runtime pin(s) to local service intent.",
    ]);
    expect(
      withDaemonRuntimePinStore(state.env, false, (db) =>
        db.prepare("SELECT phase FROM daemon_runtime_pin_migration").get(),
      ),
    ).toEqual({ phase: "complete" });
  });
});

it.each(["copied", "complete"] as const)(
  "preserves an existing foreign-source %s receipt at Gateway startup",
  async (phase) => {
    await withOpenClawTestState({ label: "retained-runtime-pins" }, async (state) => {
      withDaemonRuntimePinStore(state.env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, ?, 123)").run(
          "retained-source.sqlite",
          phase,
        );
      });
      await createProfile("gateway", state);
      await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
      expect(
        withDaemonRuntimePinStore(state.env, false, (db) =>
          db
            .prepare("SELECT source_state, phase, updated_at FROM daemon_runtime_pin_migration")
            .get(),
        ),
      ).toEqual({ source_state: "retained-source.sqlite", phase, updated_at: 123 });
    });
  },
);
