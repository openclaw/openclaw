import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertDaemonRuntimePinCurrent,
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
  withDaemonRuntimePinMigration,
} from "./runtime-pin-state.js";
import { resolveDaemonRuntimePinStorePath } from "./runtime-pin-store.js";

const runtimePath = "/runtime tools/node";
const command = { programArguments: [runtimePath, "/app/openclaw.mjs", "gateway"] };
const pin = { runtime: "node" as const, path: runtimePath };
describe("transactional runtime pin state", () => {
  it("keeps intent local with PostgreSQL selected and the shared database unavailable", async () => {
    await withOpenClawTestState({ label: "runtime-pin-local" }, async (state) => {
      fs.writeFileSync(
        state.statePath("openclaw.json"),
        JSON.stringify({
          database: {
            engine: "postgres",
            postgres: { connection: "postgres://unreachable.invalid/openclaw" },
          },
        }),
      );
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      const expected = readDaemonRuntimePin(scope, command);
      commitDaemonRuntimePin(scope, { expected, pin }, command);
      expect(readDaemonRuntimePin(scope, command).pin).toEqual(pin);
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      if (process.platform !== "win32") {
        expect(fs.statSync(resolveDaemonRuntimePinStorePath(state.env)).mode & 0o777).toBe(0o600);
        expect(fs.statSync(state.statePath("control")).mode & 0o777).toBe(0o700);
      }
    });
  });

  it("observes another writer's committed changes and rejects stale writes", async () => {
    await withOpenClawTestState({ label: "runtime-pin-current" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, null), pin }, command);
      const expected = readDaemonRuntimePin(scope, command);
      const writer = openNodeSqliteDatabase(resolveDaemonRuntimePinStorePath(state.env));
      try {
        writer.prepare("DELETE FROM daemon_runtime_pins").run();
        expect(() => assertDaemonRuntimePinCurrent(scope, expected)).toThrow(/changed/);
        expect(() => commitDaemonRuntimePin(scope, { expected, pin }, command)).toThrow(
          /changed before persistence/,
        );
        expect(readDaemonRuntimePin(scope, command).stored).toBe(false);
      } finally {
        writer.close();
      }
    });
  });

  it("surfaces malformed records and refuses unsupported local schemas", async () => {
    await withOpenClawTestState({ label: "runtime-pin-malformed" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, null), pin }, command);
      const writer = openNodeSqliteDatabase(resolveDaemonRuntimePinStorePath(state.env));
      try {
        writer.prepare("UPDATE daemon_runtime_pins SET value_json = ?").run("{ malformed");
        expect(() => readDaemonRuntimePin(scope, command)).toThrow();
        expect(writer.prepare("SELECT value_json FROM daemon_runtime_pins").get()?.value_json).toBe(
          "{ malformed",
        );
        writer.exec("PRAGMA user_version=2");
        expect(() => readDaemonRuntimePin(scope, command)).toThrow(/unsupported schema version 2/);
      } finally {
        writer.close();
      }
    });
  });
  it("refuses a linked local store instead of following another owner's file", async () => {
    await withOpenClawTestState({ label: "runtime-pin-link" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, null), pin }, command);
      const pathname = resolveDaemonRuntimePinStorePath(state.env);
      fs.renameSync(pathname, pathname + ".original");
      fs.symlinkSync(pathname + ".original", pathname);
      expect(() => readDaemonRuntimePin(scope, command)).toThrow(/safely opened/);
    });
  });

  it("refuses a linked control directory before writing into it", async () => {
    await withOpenClawTestState({ label: "runtime-pin-directory-link" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      const expected = readDaemonRuntimePin(scope, null);
      const target = state.statePath("other");
      fs.mkdirSync(target);
      fs.renameSync(state.statePath("control"), state.statePath("control.original"));
      fs.symlinkSync(target, state.statePath("control"), "dir");
      expect(() => commitDaemonRuntimePin(scope, { expected, pin }, command)).toThrow(
        /directory is unsafe/,
      );
      expect(fs.readdirSync(target)).toEqual([]);
    });
  });

  it("recovers an interrupted first store creation without inventing intent", async () => {
    await withOpenClawTestState({ label: "runtime-pin-first-create" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      fs.mkdirSync(state.statePath("control"), { mode: 0o700 });
      fs.writeFileSync(resolveDaemonRuntimePinStorePath(state.env), "", { mode: 0o600 });
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      const expected = readDaemonRuntimePin(scope, command);
      expect(expected.stored).toBe(false);
      commitDaemonRuntimePin(scope, { expected, pin }, command);
      expect(readDaemonRuntimePin(scope, command).pin).toEqual(pin);
    });
  });

  it("keeps absent/default state read-only and persists explicit intent across reopen", async () => {
    await withOpenClawTestState({ label: "runtime-pin" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      expect(() => readDaemonRuntimePin(scope, command)).toThrow(/migration pending/);
      expect(fs.existsSync(state.statePath("control", "services.sqlite"))).toBe(false);
      const empty = await withDaemonRuntimePinMigration(state.env, () =>
        readDaemonRuntimePin(scope, command),
      );
      expect(empty.pin).toBeUndefined();
      commitDaemonRuntimePin(scope, { expected: empty, pin }, command);
      closeOpenClawStateDatabaseForTest();
      expect(readDaemonRuntimePin(scope, command).pin).toEqual(pin);
      expect(readDaemonRuntimePin({ ...scope, kind: "node" }, command).pin).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_PROFILE: "other" } },
          command,
        ).pin,
      ).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_CONFIG_PATH: state.path("other.json") } },
          command,
        ).pin,
      ).toBeUndefined();
    });
  });
  it("rejects stale plans and definition mismatch without adopting operator overrides", async () => {
    await withOpenClawTestState({ label: "runtime-pin-stale" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      const original = readDaemonRuntimePin(scope, command);
      commitDaemonRuntimePin(scope, { expected: original, pin }, command);
      expect(() => assertDaemonRuntimePinCurrent(scope, original)).toThrow(/changed/);
      expect(() => commitDaemonRuntimePin(scope, { expected: original }, null)).toThrow(/changed/);
      const override = { programArguments: ["/operator/wrapper"], managedDefinition: command };
      expect(readDaemonRuntimePin(scope, override).pin).toEqual(pin);
      expect(() => readDaemonRuntimePin(scope, { programArguments: ["/different/node"] })).toThrow(
        /changed/,
      );
      expect(readDaemonRuntimePin(scope, null).pin).toBeUndefined();
      const explicit = readDaemonRuntimePinForInstall(scope, override, true);
      expect(explicit.pin).toBeUndefined();
      expect(explicit.revision).toBe(readDaemonRuntimePin(scope, override).revision);
      expect(explicit.definition).toBe(readDaemonRuntimePin(scope, override).definition);
      commitDaemonRuntimePin(scope, { expected: explicit }, null);
      expect(readDaemonRuntimePin(scope, command).stored).toBe(false);
    });
  });
  it("retains inactive wrapper pins separately and clears intent transactionally", async () => {
    await withOpenClawTestState({ label: "runtime-pin-wrapper" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      await withDaemonRuntimePinMigration(state.env, () => undefined);
      const wrapped = { programArguments: ["/wrapper", "gateway"] };
      const bun = { runtime: "bun" as const, path: "/runtime tools/bun" };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, null), pin: bun },
        wrapped,
      );
      expect(readDaemonRuntimePin(scope, wrapped).pin).toEqual(bun);
      const updated = { programArguments: [bun.path, "/new/openclaw.mjs", "gateway"] };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, wrapped), pin: bun },
        updated,
      );
      expect(readDaemonRuntimePin(scope, updated).pin).toEqual(bun);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, updated) }, updated);
      expect(readDaemonRuntimePin(scope, updated).pin).toBeUndefined();
    });
  });
});
