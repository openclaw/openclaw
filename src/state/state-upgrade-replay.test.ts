import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processRole from "../infra/database-engine/admission-scope.js";
import { withLiveStateReads } from "./artifact-preserving-state-reads.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { upgradeStateOnGatewayStart } from "./state-upgrade-startup.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it("retains the WAL commit from a shipped interrupted plan before the startup guard", async () => {
  vi.spyOn(processRole, "getDatabaseProcessRole").mockReturnValue("gateway");
  const root = dirs.make("state-upgrade-replay-");
  const stateDir = path.join(root, "state");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const appVersion = "2026.11.10";
  const workDir = path.join(stateDir, `.upgrade-${appVersion}-123-456`);
  const shadow = path.join(workDir, "state");
  const live = path.join(stateDir, "state", "openclaw.sqlite");
  const next = path.join(shadow, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ gateway: { mode: "local" } }));

  // Produce a real WAL-only commit and a coherent staged image, as the shipped
  // private migration did. The live main is deliberately the pre-commit image.
  {
    using source = new DatabaseSync(path.join(root, "source.sqlite"));
    source.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    source.exec(getOpenClawStatePredecessorSchema(41));
    source.exec(`PRAGMA user_version = 41;
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', 41, 1, 1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);
      INSERT INTO config_machine_state VALUES ('auth.sharedStore', '{"location":"state-db"}', 1);
      PRAGMA wal_checkpoint(TRUNCATE);`);
    source
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
      .run("replay.committed", '"committed-before-crash"', 1);
    expect(fs.statSync(path.join(root, "source.sqlite-wal")).size).toBeGreaterThan(0);
    fs.copyFileSync(path.join(root, "source.sqlite"), live);
    source.exec(`ALTER TABLE worker_session_placements ADD COLUMN confirmed_loss_recovery_json TEXT;
      PRAGMA user_version = 42;
      UPDATE schema_meta SET schema_version = 42 WHERE meta_key = 'primary';
      UPDATE config_machine_state SET value_json = '42'
        WHERE state_key = 'state.schema.contentVersion';`);
    source.prepare("VACUUM INTO ?").run(next);
    for (const suffix of ["-wal", "-shm"]) {
      fs.copyFileSync(path.join(root, `source.sqlite${suffix}`), `${live}${suffix}`);
    }
  }
  const plan = {
    appVersion,
    ops: [
      { kind: "remove", live: `${live}-wal` },
      { kind: "remove", live: `${live}-shm` },
      { kind: "replace", live, next },
    ],
  };
  fs.writeFileSync(path.join(workDir, "plan.json"), JSON.stringify(plan));
  // Exact interruption point: applyPlan already preserved/removed the WAL and
  // removed SHM, but has not renamed the coherent staged database into place.
  fs.linkSync(`${live}-wal`, `${live}-wal.pre-${appVersion}`);
  fs.rmSync(`${live}-wal`);
  fs.rmSync(`${live}-shm`);
  {
    using original = new DatabaseSync(live, { readOnly: true });
    expect(
      original
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'replay.committed'")
        .get(),
    ).toBeUndefined();
    using staged = new DatabaseSync(next, { readOnly: true });
    expect(
      staged
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'replay.committed'")
        .get(),
    ).toEqual({ value_json: '"committed-before-crash"' });
  }

  await withLiveStateReads(async () => {
    await upgradeStateOnGatewayStart(env, () => {
      using settled = new DatabaseSync(live, { readOnly: true });
      expect(
        settled
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'replay.committed'",
          )
          .get(),
      ).toEqual({ value_json: '"committed-before-crash"' });
      return false;
    });
  });
  await closeOpenClawStateDatabaseAsync();
  using recovered = new DatabaseSync(live, { readOnly: true });
  expect(
    recovered
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'replay.committed'")
      .get(),
  ).toEqual({ value_json: '"committed-before-crash"' });
  expect(recovered.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    recovered.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  expect(recovered.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(fs.readdirSync(stateDir).filter((name) => name.startsWith(".upgrade-"))).toEqual([]);
  expect(
    JSON.parse(fs.readFileSync(path.join(stateDir, `.upgraded-${appVersion}.json`), "utf8")),
  ).toEqual(plan);
});

it("settles prior durable config intent before asking a guard that refuses the new start", async () => {
  const stateDir = dirs.make("state-upgrade-replay-guard-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const workDir = path.join(stateDir, ".upgrade-2026.11.10-123-456");
  fs.mkdirSync(workDir);
  const next = path.join(workDir, "openclaw.json");
  const settled = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{ interrupted config");
  fs.writeFileSync(next, settled);
  fs.writeFileSync(
    path.join(workDir, "plan.json"),
    JSON.stringify({
      appVersion: "2026.11.10",
      ops: [{ kind: "replace", live: env.OPENCLAW_CONFIG_PATH, next }],
    }),
  );

  let guarded = false;
  await upgradeStateOnGatewayStart(env, (start) => {
    guarded = true;
    expect(start).toEqual({ configExists: true, mode: "local" });
    return false;
  });

  expect(guarded).toBe(true);
  expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(settled);
  expect(fs.existsSync(workDir)).toBe(false);
  expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
});
