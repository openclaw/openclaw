import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OpenClawCommand } from "../cli/program/openclaw-command.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { collectPluginDoctorStateMigrationPlans } from "../infra/state-migrations.plugin-doctor.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createPluginCliLoadSession, loadPluginCliDescriptors } from "./cli-registry-loader.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

// Regression: the actual Matrix package, Doctor contract loader,
// migration ledger, CLI admission/registration, and shipped Commander subclass.
// No direct registerMatrixDoctorCommands call, model, Gateway, or network account.
it("keeps explicit Matrix recovery reachable while a required migration is pending", async () => {
  const root = dirs.make("ur-200790-");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const configPath = path.join(root, "openclaw.json");
  for (const [key, value] of Object.entries({
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  const config = {
    channels: { matrix: { enabled: true } },
    plugins: { allow: ["matrix"], entries: { matrix: { enabled: true } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const storageRootDir = path.join(stateDir, "matrix");
  fs.mkdirSync(storageRootDir, { recursive: true });
  const markerPath = path.join(storageRootDir, "crypto-idb-snapshot.json.owner.poisoned");
  fs.writeFileSync(markerPath, "unsafe\n");
  // Persist a synthetic canonical snapshot with the shipped data format, not real keys.
  const snapshotJson = JSON.stringify([{ name: "crypto", version: 1, stores: [] }]);
  const snapshotStore = createPluginStateKeyedStore<Record<string, unknown>>("matrix", {
    namespace: "idb-snapshot",
    maxEntries: 20_000,
    env: { ...process.env, OPENCLAW_STATE_DIR: storageRootDir },
  });
  await snapshotStore.register("current:snapshot:synthetic:0", {
    kind: "snapshot-chunk",
    index: 0,
    data: snapshotJson,
  });
  await snapshotStore.register("current:meta", {
    kind: "meta",
    version: 1,
    generation: "synthetic",
    chunkCount: 1,
    digest: createHash("sha256").update(snapshotJson).digest("hex"),
    databaseCount: 1,
    persistedAt: "2026-11-01T00:00:00Z",
  });

  // Control: the real Matrix CLI metadata is discoverable before the obligation.
  expect(
    (await loadPluginCliDescriptors({ cfg: config, primaryCommand: "matrix" })).map(
      ({ name }) => name,
    ),
  ).toContain("matrix");
  const pending = {
    pluginId: "matrix",
    reason: "Synthetic retained Matrix state requires Doctor",
    command: "openclaw doctor --fix",
    requiresStateMigration: true as const,
  };
  await recordDeferredPluginMigrations({ env: process.env, pending: [pending] });
  const plans = await collectPluginDoctorStateMigrationPlans(
    { config, env: process.env, stateDir, oauthDir: path.join(stateDir, "credentials") },
    { pluginIds: ["matrix"], includeDoctorOnly: true },
  );
  expect(
    plans.plans.find(({ migration }) => migration.id === "matrix-crypto-unsafe-state")?.preview,
  ).toEqual([
    `Matrix crypto store is blocked after unsafe final save: ${storageRootDir}. Run openclaw matrix doctor inspect; recovery is never automatic.`,
  ]);

  const session = createPluginCliLoadSession();
  const program = new OpenClawCommand("openclaw").exitOverride();
  // A built-in sibling makes Commander diagnose the absent root as unknown.
  program.command("doctor");
  program.configureOutput({ writeErr() {} });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
      mode: "lazy",
      primary: "matrix",
      session,
    });
    session.close();
    const parse = (args: string[]) =>
      session.withCache(() => program.parseAsync(args, { from: "user" }));
    const inspect = async () => {
      await parse(["matrix", "doctor", "inspect", "--json"]);
      return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    };
    expect(await inspect()).toEqual({ blocked: [{ account: "default", rootDir: storageRootDir }] });
    expect(fs.readFileSync(markerPath, "utf8")).toBe("unsafe\n");
    expect(readDeferredPluginMigrations({ env: process.env })).toEqual([pending]);
    await expect(parse(["matrix", "profile", "set", "--name", "synthetic"])).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
    await expect(
      parse(["matrix", "doctor", "recover", "--account", "default"]),
    ).rejects.toMatchObject({
      code: "commander.missingMandatoryOptionValue",
    });
    await expect(
      parse(["matrix", "doctor", "recover", "--account", "unknown", "--accept-snapshot-rollback"]),
    ).rejects.toThrow("found 0");
    expect(fs.readFileSync(markerPath, "utf8")).toBe("unsafe\n");
    expect(readDeferredPluginMigrations({ env: process.env })).toEqual([pending]);
    await parse([
      "matrix",
      "doctor",
      "recover",
      "--account",
      "default",
      "--accept-snapshot-rollback",
    ]);
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining("openclaw update repair"));
    expect(await inspect()).toEqual({ blocked: [] });
    expect(fs.readFileSync(markerPath, "utf8")).toMatch(/^[a-f0-9]{32}\n$/);
    expect((await snapshotStore.lookup("current:snapshot:synthetic:0"))?.data).toBe(snapshotJson);
    expect(readDeferredPluginMigrations({ env: process.env })).toEqual([pending]);
    expect(program.commands.filter((command) => command.name() === "matrix")).toHaveLength(1);
  } finally {
    session.close();
    output.mockRestore();
  }
});
