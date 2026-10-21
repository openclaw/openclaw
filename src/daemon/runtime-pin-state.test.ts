import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it as base, vi } from "vitest";
import { inspectServiceRuntimeIntent } from "../cli/daemon-cli/status.runtime-intent.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createConfigMachineStateStep } from "../infra/state-migrations.config-machine-state-step.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  assertDaemonRuntimePinCurrent,
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
  readDaemonRuntimePinMigrationPending,
  withDaemonRuntimePinMigration,
} from "./runtime-pin-state.js";
import {
  resolveDaemonRuntimePinStorePath,
  withDaemonRuntimePinStore,
} from "./runtime-pin-store.js";
import type { DaemonRuntimePinUpdate } from "./runtime-pin-types.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const runtimePath = "/runtime tools/node";
const command = { programArguments: [runtimePath, "/app/openclaw.mjs", "gateway"] };
const pin = { runtime: "node" as const, path: runtimePath };
function pinFixture(state: OpenClawTestState) {
  const scope = { kind: "gateway" as const, env: state.env };
  const read = (definition: GatewayServiceCommandConfig | null = command) =>
    readDaemonRuntimePin(scope, definition);
  const save = (
    update: DaemonRuntimePinUpdate,
    definition: GatewayServiceCommandConfig | null = command,
  ) => commitDaemonRuntimePin(scope, update, definition);
  const migrate = () => withDaemonRuntimePinMigration(state.env, () => undefined);
  return {
    ...state,
    scope,
    read,
    save,
    migrate,
    initialize: async () => {
      await migrate();
      save({ expected: read(null), pin });
    },
  };
}
const it = base.extend<{ p: ReturnType<typeof pinFixture> }>({
  p: async ({ task }, use) =>
    withOpenClawTestState({ label: task.name }, (state) => use(pinFixture(state))),
});
afterEach(() => vi.restoreAllMocks());

describe("transactional runtime pin state", () => {
  beforeEach(() => vi.stubEnv("OPENCLAW_PROFILE", `runtime-pin-test-${process.pid}`));
  afterEach(() => vi.unstubAllEnvs());
  it("keeps intent local with PostgreSQL selected and the shared database unavailable", async ({
    p,
  }) => {
    fs.writeFileSync(
      p.statePath("openclaw.json"),
      JSON.stringify({
        database: {
          engine: "postgres",
          postgres: { connection: "postgres://unreachable.invalid/openclaw" },
        },
      }),
    );
    await p.migrate();
    const expected = p.read();
    p.save({ expected, pin });
    expect(p.read().pin).toEqual(pin);
    expect(fs.existsSync(p.statePath("state", "openclaw.sqlite"))).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(resolveDaemonRuntimePinStorePath(p.env)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(p.statePath("control")).mode & 0o777).toBe(0o700);
    }
  });

  it("observes another writer's committed changes and rejects stale writes", async ({ p }) => {
    await p.initialize();
    const expected = p.read();
    const writer = openNodeSqliteDatabase(resolveDaemonRuntimePinStorePath(p.env));
    try {
      writer.prepare("DELETE FROM daemon_runtime_pins").run();
      expect(() => assertDaemonRuntimePinCurrent(p.scope, expected)).toThrow(/changed/);
      expect(() => p.save({ expected, pin })).toThrow(/changed before persistence/);
      expect(p.read().stored).toBe(false);
    } finally {
      writer.close();
    }
  });

  it("surfaces malformed records and refuses unsupported local schemas", async ({ p }) => {
    await p.initialize();
    const writer = openNodeSqliteDatabase(resolveDaemonRuntimePinStorePath(p.env));
    try {
      writer.prepare("UPDATE daemon_runtime_pins SET value_json = ?").run("{ malformed");
      expect(() => p.read()).toThrow();
      expect(writer.prepare("SELECT value_json FROM daemon_runtime_pins").get()?.value_json).toBe(
        "{ malformed",
      );
      writer.exec("PRAGMA user_version=2");
      expect(() => p.read()).toThrow(/unsupported schema version 2/);
    } finally {
      writer.close();
    }
  });
  it("refuses a linked local store instead of following another owner's file", async ({ p }) => {
    await p.initialize();
    const pathname = resolveDaemonRuntimePinStorePath(p.env);
    fs.renameSync(pathname, pathname + ".original");
    fs.symlinkSync(pathname + ".original", pathname);
    expect(() => p.read()).toThrow(/safely opened/);
  });

  it("refuses a linked control directory before writing into it", async ({ p }) => {
    await p.migrate();
    const expected = p.read(null);
    const target = p.statePath("other");
    fs.mkdirSync(target);
    fs.renameSync(p.statePath("control"), p.statePath("control.original"));
    fs.symlinkSync(target, p.statePath("control"), "dir");
    expect(() => p.save({ expected, pin })).toThrow(/directory is unsafe/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("recovers an interrupted first store creation without inventing intent", async ({ p }) => {
    fs.mkdirSync(p.statePath("control"), { mode: 0o700 });
    fs.writeFileSync(resolveDaemonRuntimePinStorePath(p.env), "", { mode: 0o600 });
    await p.migrate();
    const expected = p.read();
    expect(expected.stored).toBe(false);
    p.save({ expected, pin });
    expect(p.read().pin).toEqual(pin);
  });

  it("keeps absent/default state read-only and persists explicit intent across reopen", async ({
    p,
  }) => {
    expect(() => p.read()).toThrow(/migration pending/);
    expect(fs.existsSync(p.statePath("control", "services.sqlite"))).toBe(false);
    const empty = await withDaemonRuntimePinMigration(p.env, () => p.read());
    expect(empty.pin).toBeUndefined();
    p.save({ expected: empty, pin });
    closeOpenClawStateDatabaseForTest();
    expect(p.read().pin).toEqual(pin);
    expect(readDaemonRuntimePin({ ...p.scope, kind: "node" }, command).pin).toBeUndefined();
    expect(
      readDaemonRuntimePin({ ...p.scope, env: { ...p.env, OPENCLAW_PROFILE: "other" } }, command)
        .pin,
    ).toBeUndefined();
    expect(
      readDaemonRuntimePin(
        { ...p.scope, env: { ...p.env, OPENCLAW_CONFIG_PATH: p.path("other.json") } },
        command,
      ).pin,
    ).toBeUndefined();
  });
  it("rejects stale plans and definition mismatch without adopting operator overrides", async ({
    p,
  }) => {
    await p.migrate();
    const original = p.read();
    p.save({ expected: original, pin });
    expect(() => assertDaemonRuntimePinCurrent(p.scope, original)).toThrow(/changed/);
    expect(() => p.save({ expected: original }, null)).toThrow(/changed/);
    const override = { programArguments: ["/operator/wrapper"], managedDefinition: command };
    expect(p.read(override).pin).toEqual(pin);
    expect(() => readDaemonRuntimePin(p.scope, { programArguments: ["/different/node"] })).toThrow(
      /changed/,
    );
    expect(p.read(null).pin).toBeUndefined();
    const explicit = readDaemonRuntimePinForInstall(p.scope, override, true);
    expect(explicit.pin).toBeUndefined();
    expect(explicit.revision).toBe(p.read(override).revision);
    expect(explicit.definition).toBe(p.read(override).definition);
    p.save({ expected: explicit }, null);
    expect(p.read().stored).toBe(false);
  });
  it("retains inactive wrapper pins separately and clears intent transactionally", async ({
    p,
  }) => {
    await p.migrate();
    const wrapped = { programArguments: ["/wrapper", "gateway"] };
    const bun = { runtime: "bun" as const, path: "/runtime tools/bun" };
    p.save({ expected: p.read(null), pin: bun }, wrapped);
    expect(p.read(wrapped).pin).toEqual(bun);
    const updated = { programArguments: [bun.path, "/new/openclaw.mjs", "gateway"] };
    p.save({ expected: p.read(wrapped), pin: bun }, updated);
    expect(p.read(updated).pin).toEqual(bun);
    p.save({ expected: p.read(updated) }, updated);
    expect(p.read(updated).pin).toBeUndefined();
  });
});

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
describe("runtime pin migration before service resume", () => {
  it.for([
    { entry: "resume", malformed: false },
    { entry: "resume", malformed: true },
    { entry: "post-update Doctor", malformed: false },
  ])(
    "preserves stored intent through $entry (malformed=$malformed)",
    async ({ entry, malformed }, { p: state }) => {
      // Leave the receipt absent while creating private files on the actual host platform.
      withDaemonRuntimePinStore(state.env, true, () => undefined);
      openOpenClawStateDatabase({ env: state.env });
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(state.stateDir);
      const env = { ...state.env, OPENCLAW_LAUNCHD_LABEL: "dev.openclaw.migration-fixture" };
      const fixtureCommand = {
        programArguments: ["/fixture/node", "/fixture/openclaw.mjs", "gateway"],
      };
      const fixturePin = { runtime: "node", path: "/fixture/node" };
      const stateKey = `daemon-runtime-pin:${digest(["gateway", "darwin", env.OPENCLAW_LAUNCHD_LABEL, state.configPath])}`;
      const valueJson = malformed
        ? "{ malformed"
        : JSON.stringify({
            version: 1,
            pin: fixturePin,
            definition: digest([fixtureCommand.programArguments, null]),
          });
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
            stateKey,
            valueJson,
            123,
          );
        },
        { env },
      );
      const service = createMockGatewayService();
      const status = () =>
        inspectServiceRuntimeIntent({
          kind: "gateway",
          service,
          command: fixtureCommand,
          env,
          serviceEnv: env,
          inspectionKnown: true,
        });

      if (entry === "resume") {
        expect(readDaemonRuntimePinMigrationPending(env)).toBe(true);
        expect((await status()).runtimeIntent).toEqual({
          status: "migrationPending",
          nextStep: "run openclaw doctor",
        });
        expect(() => readDaemonRuntimePin({ kind: "gateway", env }, fixtureCommand)).toThrow(
          "migration pending",
        );
      }
      const readMigratedPin = vi.fn(() => {
        expect(readDaemonRuntimePinMigrationPending(env)).toBe(false);
        const stored = withDaemonRuntimePinStore(env, false, (db) =>
          db
            .prepare(
              "SELECT value_json, updated_at_ms FROM daemon_runtime_pins WHERE state_key = ?",
            )
            .get(stateKey),
        );
        expect(stored).toEqual({ value_json: valueJson, updated_at_ms: 123 });
        if (malformed) {
          expect(() => readDaemonRuntimePin({ kind: "gateway", env }, fixtureCommand)).toThrow();
        } else {
          expect(readDaemonRuntimePin({ kind: "gateway", env }, fixtureCommand).pin).toEqual(
            fixturePin,
          );
        }
      });
      if (entry === "resume") {
        await withDaemonRuntimePinMigration(env, readMigratedPin);
      } else {
        const result = await createConfigMachineStateStep({
          config: {},
          configPath: state.configPath,
          configIncludedPaths: [],
          stateDir: state.stateDir,
          env,
        }).run();
        expect(result.warnings).toEqual([]);
        readMigratedPin();
      }
      expect(readMigratedPin).toHaveBeenCalledOnce();
      expect((await status()).runtimeIntent.status).toBe(malformed ? "unknown" : "known");
      expect(
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            db
              .prepare("SELECT state_key FROM config_machine_state WHERE state_key = ?")
              .get(stateKey),
          { env },
        ),
      ).toBeUndefined();
      expect(
        withDaemonRuntimePinStore(env, false, (db) =>
          db.prepare("SELECT source_state, phase FROM daemon_runtime_pin_migration").get(),
        ),
      ).toEqual({ source_state: resolveOpenClawStateSqlitePath(env), phase: "complete" });
    },
  );

  it("treats another state root's complete receipt as pending", async ({ p: state }) => {
    withDaemonRuntimePinStore(state.env, true, (db) => {
      db.prepare("INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, 'complete', 1)").run(
        path.join(state.root, "other.sqlite"),
      );
    });
    expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
  });

  it("does not admit the service callback when migration conflicts", async ({ p: state }) => {
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(state.stateDir);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
          "daemon-runtime-pin:conflict",
          "source",
          1,
        );
      },
      { env: state.env },
    );
    withDaemonRuntimePinStore(state.env, true, (db) => {
      db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
        "daemon-runtime-pin:conflict",
        "target",
        2,
      );
    });
    const admitted = vi.fn();
    await expect(withDaemonRuntimePinMigration(state.env, admitted)).rejects.toThrow(
      "migration conflict",
    );
    expect(admitted).not.toHaveBeenCalled();
    expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
  });
});
