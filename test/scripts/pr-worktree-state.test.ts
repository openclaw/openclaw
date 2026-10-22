import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../../src/commands/doctor-migration-backup-restore.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../../src/infra/client-credential-schema.js";
import { generateStoredDeviceIdentity } from "../../src/infra/device-identity-material.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createProvisionOwnerFixture,
  expectProvisionComplete,
} from "./pr-worktree-owner.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("repository-owned PR provisioning state", () => {
  it.each([28, 29])("preserves private schema v%i state while provisioning", async (version) => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-schema-"));
    const stateDir = join(f.canonical, ".local", "pr-state");
    const databasePath = join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(join(stateDir, "state"), { recursive: true });
    const identity = generateStoredDeviceIdentity();
    const identityRow = {
      identity_key: "primary",
      device_id: identity.deviceId,
      public_key_pem: identity.publicKeyPem,
      private_key_pem: identity.privateKeyPem,
      created_at_ms: identity.createdAtMs,
      updated_at_ms: identity.createdAtMs,
    };
    {
      using database = new DatabaseSync(databasePath);
      database.exec(OPENCLAW_STATE_SCHEMA_SQL);
      database.exec(`PRAGMA user_version=${version}`);
      database
        .prepare("INSERT INTO schema_meta VALUES ('primary','global',?,NULL,NULL,1,1)")
        .run(version);
      database
        .prepare("INSERT INTO config_machine_state VALUES ('fixture.preserved','\"unchanged\"',1)")
        .run();
      if (version === 28) {
        database.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
        database
          .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
          .run(...Object.values(identityRow));
      }
    }
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expectProvisionComplete(f);
    const backups = readdirSync(join(stateDir, "state")).filter((name) =>
      name.endsWith(".scoped.bak"),
    );
    expect(backups).toHaveLength(version === 28 ? 1 : 0);
    {
      using database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key='fixture.preserved'",
          )
          .get(),
      ).toEqual({ value_json: '"unchanged"' });
      if (version === 28) {
        using local = new DatabaseSync(join(stateDir, "client", "credentials.sqlite"), {
          readOnly: true,
        });
        expect(local.prepare("SELECT * FROM device_identities").get()).toEqual(identityRow);
        expect(local.prepare("SELECT phase FROM client_credential_migration").get()).toEqual({
          phase: "complete",
        });
        expect(
          database.prepare("SELECT 1 FROM sqlite_schema WHERE name='device_identities'").get(),
        ).toBeUndefined();
      }
    }
    if (version === 28) {
      await restoreDoctorMigrationBackup({
        sourcePath: databasePath,
        backupPath: join(stateDir, "state", backups[0]!),
        env: { ...f.env, OPENCLAW_STATE_DIR: stateDir },
      });
      using restored = new DatabaseSync(databasePath, { readOnly: true });
      expect(restored.prepare("SELECT * FROM device_identities").all()).toEqual([identityRow]);
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 28 });
    }
    expect(existsSync(join(f.home, ".openclaw"))).toBe(false);
  });

  it.runIf(process.platform === "linux")(
    "releases its completed operation after exited loader descendants await reaping",
    () => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-exited-loaders-"));
      delete f.env.OPENCLAW_CONFIG_PATH;
      const result = f.run("entry", "", { holdExitedDescendants: true });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/successfully reaped: [1-9]/u);
      f.isolation.assertProvisioner();
      expectProvisionComplete(f);
    },
  );
  it.each([
    { mode: "native", override: false },
    { mode: "native", override: true },
    { mode: "managed", override: false },
    { mode: "managed", override: true },
  ] as const)(
    "isolates $mode state from HOME (operator override=$override)",
    ({ mode, override }) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-state-"), mode);
      // On supported filesystems, this also exercises the template registry writer.
      writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const operator = join(f.root, "operator-state");
      if (override) {
        mkdirSync(operator);
        writeFileSync(join(operator, "operator-evidence"), "leave untouched");
        f.env.OPENCLAW_STATE_DIR = operator;
      } else {
        delete f.env.OPENCLAW_CONFIG_PATH;
      }
      // The native entrypoints carry explicit argv binding, not NODE_OPTIONS.
      if (override) {
        f.env.NODE_OPTIONS = "--no-warnings";
      } else {
        delete f.env.NODE_OPTIONS;
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      f.isolation.assertProvisioner();
      expectProvisionComplete(f);
      expect(existsSync(join(f.canonical, ".local", "pr-state", "state", "openclaw.sqlite"))).toBe(
        true,
      );
      if (override) {
        expect(readdirSync(operator)).toEqual(["operator-evidence"]);
        expect(readFileSync(join(operator, "operator-evidence"), "utf8")).toBe("leave untouched");
      } else {
        expect(existsSync(operator)).toBe(false);
      }
    },
  );

  it.each(["stripped", "missing", "replaced"] as const)(
    "refuses a %s handoff binding before opening either store",
    (fault) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-binding-identity-"));
      const preload = fileURLToPath(f.isolation.binding.nodeOption.slice("--import=".length));
      if (fault === "stripped") {
        const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
        // Keep the observer but remove this child's resolver; a parent witness cannot qualify it.
        writeFileSync(
          join(f.isolation.bin, "node"),
          `#!/bin/sh\nexec ${quote(requireNodeTool("node"))} ${quote(f.isolation.nodeArgs[1]!)} "$@"\n`,
        );
      } else if (fault === "missing") {
        unlinkSync(preload);
      } else {
        const retained = join(f.root, "replaced-handoff");
        renameSync(f.isolation.binding.directory, retained);
        mkdirSync(f.isolation.binding.directory, { mode: 0o700 });
        copyFileSync(join(retained, "handoff-resolver-preload.mjs"), preload);
      }
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        fault === "stripped"
          ? /Missing private provisioner handoff preload/
          : fault === "missing"
            ? /ERR_MODULE_NOT_FOUND/
            : /directory identity changed/,
      );
      expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
      expect(existsSync(f.isolation.binding.databasePath)).toBe(false);
      expect(existsSync(f.isolation.stateDatabase)).toBe(false);
    },
  );

  it.each([
    { kind: "symlink", suffix: "" },
    { kind: "hardlink", suffix: "" },
    { kind: "symlink", suffix: "-wal" },
    { kind: "hardlink", suffix: "-wal" },
  ] as const)("refuses a handoff $kind $suffix before store access", ({ kind, suffix }) => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-binding-alias-"));
    const target = join(f.root, "private-negative-control");
    writeFileSync(target, "do not open", { mode: 0o600 });
    const alias = f.isolation.binding.databasePath + suffix;
    if (kind === "symlink") {
      symlinkSync(target, alias);
    } else {
      linkSync(target, alias);
    }
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/database (alias|hardlink) is forbidden/);
    expect(readFileSync(target, "utf8")).toBe("do not open");
    expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
    expect(existsSync(f.isolation.stateDatabase)).toBe(false);
  });
});
