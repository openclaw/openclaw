import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, vi } from "vitest";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { finishUpdateRun } from "../infra/update-run-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db-cache.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { useDoctorMaintenanceRuntimeDirectory } from "./doctor-maintenance.test-support.js";

export function setupDoctorAdmissionFixture() {
  const directories = createTempDirTracker();
  useDoctorMaintenanceRuntimeDirectory(() => directories.make("doctor-admission-custody-"));
  afterEach(() => {
    try {
      closeOpenClawStateDatabaseForTest();
      directories.cleanup();
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });
  return (keepWriter = false) => {
    const root = fs.realpathSync(directories.make("doctor-admission-source-"));
    const binding = createManagedHandoffTestBinding(root);
    // Children that never resolve shared scratch still fence every real native
    // handoff open. This guard runs before their entrypoint and never mocks SQL.
    const guard = path.join(root, "handoff-open-guard.mjs");
    const refused = path.join(root, "refused", "managed-update-handoffs.sqlite");
    fs.mkdirSync(path.dirname(refused));
    fs.writeFileSync(
      guard,
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import sqlite from 'node:sqlite';
      import { syncBuiltinESMExports } from 'node:module';
      import { fileURLToPath } from 'node:url';
      const root = ${JSON.stringify(root)};
      const expected = ${JSON.stringify(binding.databasePath)};
      const NativeDatabase = sqlite.DatabaseSync;
      sqlite.DatabaseSync = new Proxy(NativeDatabase, {
        construct(target, args, newTarget) {
          let location = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
          if (location.startsWith('file:')) location = fileURLToPath(location);
          let resolved = path.resolve(location);
          try { resolved = fs.realpathSync(resolved); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (path.basename(resolved) === 'managed-update-handoffs.sqlite') {
            assert.equal(resolved, expected, 'Handoff must use the task-private database');
            assert.equal(fs.realpathSync(path.dirname(resolved)), root);
          }
          return Reflect.construct(target, args, newTarget);
        }
      });
      syncBuiltinESMExports();
      // A wrong but disposable path must be refused before SQLite creates it.
      assert.throws(() => new sqlite.DatabaseSync(${JSON.stringify(refused)}),
        /Handoff must use the task-private database/);
      assert.equal(fs.existsSync(${JSON.stringify(refused)}), false);
      const native = new sqlite.DatabaseSync(':memory:');
      assert.equal(native.prepare('SELECT 1 AS value').get().value, 1);
      native.close();
      fs.writeFileSync(path.join(root, 'sqlite-open-guard-' + process.pid + '.json'),
        JSON.stringify({ pid: process.pid, entry: process.argv[1], databasePath: expected }));
    `,
    );
    vi.stubEnv(
      "NODE_OPTIONS",
      `${process.env.NODE_OPTIONS ?? ""} ${binding.nodeOption} --import=${pathToFileURL(guard).href}`.trim(),
    );
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    expect(binding.assertPath(resolveManagedUpdateLeaseDatabasePath())).toBe(binding.databasePath);
    // Compiled runtime modules use native builtin exports, outside Vitest's facade.
    // Observe the actual functions and synchronize ESM bindings; calls stay real.
    const spawns = [
      vi.spyOn(childProcess, "spawnSync"),
      vi.spyOn(childProcess, "spawn"),
      vi.spyOn(childProcess, "execFile"),
    ];
    syncBuiltinESMExports();
    const env = { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    finishUpdateRun(run.runId, { status: "succeeded" }, { env });
    if (!keepWriter) {
      closeOpenClawStateDatabaseForTest();
    }
    const database = path.join(root, "state", "openclaw.sqlite");
    // Even artifact hashing must not close raw source descriptors in a writer's process.
    const family = () => {
      const child = childProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import fs from 'node:fs';
        import { createHash } from 'node:crypto';
        const database = process.argv[1];
        console.log(JSON.stringify(['','-wal','-shm','-journal'].map(suffix => {
          try { return createHash('sha256').update(fs.readFileSync(database + suffix)).digest('hex'); }
          catch(error) { if(error.code === 'ENOENT') return null; throw error; }
        })));
      `,
          database,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout) as unknown;
    };
    const assertIsolation = () => {
      const witnesses = fs.readdirSync(root).filter((name) => name.startsWith("preflight-"));
      let guardedWorkers = 0;
      for (const spy of spawns) {
        for (const [index, call] of spy.mock.calls.entries()) {
          const args = call[1];
          if (call[0] !== process.execPath || !Array.isArray(args)) {
            continue;
          }
          const marker = args.indexOf("--openclaw-sqlite-readonly-child");
          if (marker < 1) {
            continue;
          }
          const result = spy.mock.results[index];
          const pid = result?.type === "return" ? result.value?.pid : undefined;
          expect(pid).toBeDefined();
          const records = witnesses
            .filter((name) => name.startsWith(`preflight-${pid}-0-`))
            .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")));
          expect(records.length).toBeGreaterThan(0);
          for (const witness of records) {
            expect(witness.databasePath).toBe(binding.databasePath);
            expect(witness.realParent).toBe(root);
          }
          const entry = args[marker - 1];
          if (typeof entry !== "string") {
            throw new Error("Worker entrypoint is missing");
          }
          const guarded = JSON.parse(
            fs.readFileSync(path.join(root, `sqlite-open-guard-${pid}.json`), "utf8"),
          );
          expect(guarded).toEqual({ pid, entry, databasePath: binding.databasePath });
          expect(args[marker + 2]).toBe(database);
          // An actual resolver consumer must have its own witness. Explicit-path
          // workers need no fabricated consumer; their native opener is fenced.
          if (records.some((record) => record.phase === "consumer")) {
            assertManagedHandoffTestConsumer(binding, pid, path.dirname(path.dirname(entry)));
          }
          guardedWorkers++;
        }
      }
      expect(guardedWorkers).toBeGreaterThan(0);
      binding.assertPath(resolveManagedUpdateLeaseDatabasePath());
    };
    const admission = resolveDoctorUpdateAdmission(env);
    return {
      env,
      database,
      family,
      admission,
      assertIsolation,
      createStateDir: () => directories.make("doctor-admission-replacement-"),
    };
  };
}
