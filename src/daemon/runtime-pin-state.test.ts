import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it as base, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
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
  it("migrates stored intent before admitting the service callback", async ({ p }) => {
    withDaemonRuntimePinStore(p.env, true, () => undefined);
    openOpenClawStateDatabase({ env: p.env });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(p.stateDir);
    const env = { ...p.env, OPENCLAW_LAUNCHD_LABEL: "dev.openclaw.migration-fixture" };
    const key =
      "daemon-runtime-pin:" +
      digest(["gateway", "darwin", env.OPENCLAW_LAUNCHD_LABEL, p.configPath]);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
          key,
          JSON.stringify({ version: 1, pin, definition: digest([command.programArguments, null]) }),
          123,
        );
      },
      { env },
    );
    const read = () => readDaemonRuntimePin({ kind: "gateway", env }, command);
    expect(readDaemonRuntimePinMigrationPending(env)).toBe(true);
    expect(read).toThrow("migration pending");
    const admitted = vi.fn(() => {
      expect(readDaemonRuntimePinMigrationPending(env)).toBe(false);
      expect(read().pin).toEqual(pin);
    });
    await withDaemonRuntimePinMigration(env, admitted);
    expect(admitted).toHaveBeenCalledOnce();
  });

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
