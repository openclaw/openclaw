import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const schemaCases = [
  [28, "checkout"],
  [29, "checkout"],
  [28, "unclassified extract"],
] as const;

function extractUnclassifiedWrapper() {
  const source = tempDirs.make("openclaw-pr-anchor-");
  copyPrWrapperSources(source);
  linkPrWrapperDependencies(source);
  // A forked preflight child missing from the extracted closure leaves the store unclassified.
  rmSync(join(source, "src/state/openclaw-agent-schema-inspection.worker.ts"));
  return source;
}

describePosix("repository-owned PR provisioning state", () => {
  it.each(schemaCases)("preserves private schema v%i state from %s", (version, source) => {
    const f = createProvisionOwnerFixture(
      tempDirs.make("openclaw-pr-schema-"),
      "native",
      128,
      source === "checkout" ? undefined : extractUnclassifiedWrapper(),
    );
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
  it.each(["native", "managed"] as const)(
    "isolates %s state from HOME and operator overrides",
    (mode) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-state-"), mode);
      // On supported filesystems, this also exercises the template registry writer.
      writeFileSync(f.env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const operator = join(f.root, "operator-state");
      mkdirSync(operator);
      writeFileSync(join(operator, "operator-evidence"), "leave untouched");
      f.env.OPENCLAW_STATE_DIR = operator;
      // The native entrypoints carry explicit argv binding, not NODE_OPTIONS.
      f.env.NODE_OPTIONS = "--no-warnings";
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      f.isolation.assertProvisioner();
      expectProvisionComplete(f);
      expect(existsSync(join(f.canonical, ".local", "pr-state", "state", "openclaw.sqlite"))).toBe(
        true,
      );
      expect(readdirSync(operator)).toEqual(["operator-evidence"]);
      expect(readFileSync(join(operator, "operator-evidence"), "utf8")).toBe("leave untouched");
    },
  );

  it("refuses a stripped handoff binding before opening either store", () => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-binding-identity-"));
    const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
    // Keep the observer but remove this child's resolver; a parent witness cannot qualify it.
    writeFileSync(
      join(f.isolation.bin, "node"),
      `#!/bin/sh\nexec ${quote(requireNodeTool("node"))} ${quote(f.isolation.nodeArgs[1]!)} "$@"\n`,
    );
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Missing private provisioner handoff preload/);
    expect(readFileSync(f.isolation.observations, "utf8")).toBe("");
    expect(existsSync(f.isolation.binding.databasePath)).toBe(false);
    expect(existsSync(f.isolation.stateDatabase)).toBe(false);
  });
});
