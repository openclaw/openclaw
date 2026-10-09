import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  initOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

let templatePath: string;

beforeAll(async () => {
  templatePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-init-template-") },
  }).path;
  await closeOpenClawStateDatabaseAsync();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function createExistingState(mutate?: (db: DatabaseSync) => void) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-init-current-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(pathname), { recursive: true });
  copyFileSync(templatePath, pathname);
  const db = new DatabaseSync(pathname);
  try {
    db.exec(`INSERT INTO schema_meta
      (meta_key, role, schema_version, app_version, created_at, updated_at)
      VALUES ('startup-migrations', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, 'synthetic-existing-checkpoint', 10, 20);`);
    mutate?.(db);
    return { options: { env, path: pathname } };
  } finally {
    db.close();
  }
}

describe("initialization-only shared-state admission", () => {
  it.each(["absent", "zero-byte", "native-bootstrap"])(
    "initializes %s state without recording migration completion",
    async (kind) => {
      const root = tempDirs.make("openclaw-init-");
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "custom.json"),
      };
      const pathname = path.join(root, "state", "openclaw.sqlite");
      const configBytes = '{"plugins":{"enabled":false}}\n';
      writeFileSync(env.OPENCLAW_CONFIG_PATH, configBytes);
      if (kind === "zero-byte") {
        mkdirSync(path.dirname(pathname), { recursive: true });
        writeFileSync(pathname, "");
      }

      if (kind === "native-bootstrap") {
        mkdirSync(path.dirname(pathname), { recursive: true });
        const native = new DatabaseSync(pathname);
        try {
          native.exec(`
            CREATE TABLE device_identities (
              identity_key TEXT NOT NULL PRIMARY KEY,
              device_id TEXT NOT NULL,
              public_key_pem TEXT NOT NULL,
              private_key_pem TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            ) STRICT;
            CREATE INDEX idx_device_identities_device
              ON device_identities(device_id, updated_at_ms DESC);
            INSERT INTO device_identities VALUES
              ('primary', 'synthetic-device', 'synthetic-public', 'synthetic-private', 10, 20);
          `);
        } finally {
          native.close();
        }
      }

      expect(initOpenClawStateDatabase({ env })).toEqual({
        databasePath: pathname,
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        status: "created",
      });
      const db = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(db.prepare("SELECT * FROM device_pairing_paired").all()).toEqual([]);
        expect(db.prepare("SELECT meta_key FROM schema_meta ORDER BY meta_key").all()).toEqual([
          { meta_key: "primary" },
        ]);
        expect(db.prepare("SELECT * FROM state_leases").all()).toEqual([]);
        if (kind === "native-bootstrap") {
          expect(db.prepare("SELECT * FROM device_identities").all()).toEqual([
            {
              identity_key: "primary",
              device_id: "synthetic-device",
              public_key_pem: "synthetic-public",
              private_key_pem: "synthetic-private",
              created_at_ms: 10,
              updated_at_ms: 20,
            },
          ]);
        }
      } finally {
        db.close();
      }
      const bytes = readFileSync(pathname);
      expect(initOpenClawStateDatabase({ env })).toEqual({
        databasePath: pathname,
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        status: "found",
      });
      expect(readFileSync(pathname).equals(bytes)).toBe(true);
      openOpenClawStateDatabase({ env });
      await closeOpenClawStateDatabaseAsync();
      expect(readFileSync(pathname).equals(bytes)).toBe(true);
      expect(readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(configBytes);
      expect(existsSync(path.join(root, "workspace"))).toBe(false);
      expect(existsSync(path.join(root, "credentials"))).toBe(false);
    },
  );

  it("finds current state without rewriting application data or checkpoint bytes", () => {
    const { options } = createExistingState();
    const before = readFileSync(options.path);
    expect(initOpenClawStateDatabase(options)).toEqual({
      databasePath: options.path,
      schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      status: "found",
    });
    expect(readFileSync(options.path).equals(before)).toBe(true);
  });

  it.each(["older", "newer", "unknown", "drift"] as const)(
    "refuses %s state without changing it",
    (kind) => {
      const { options } = createExistingState((db) => {
        if (kind === "drift") {
          db.exec(
            "ALTER TABLE device_pairing_paired ADD COLUMN unexpected TEXT NOT NULL DEFAULT 'synthetic';",
          );
        } else {
          const version =
            kind === "newer" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : kind === "older" ? 1 : 0;
          db.exec(`PRAGMA user_version = ${version};`);
        }
      });
      const before = readFileSync(options.path);
      if (kind === "older" || kind === "unknown") {
        expect(() => initOpenClawStateDatabase(options)).toThrow(StartupMaintenanceRequiredError);
      } else {
        expect(() => initOpenClawStateDatabase(options)).toThrow(
          kind === "newer" ? /newer/ : /column definitions differ for device_pairing_paired/,
        );
      }
      expect(readFileSync(options.path).equals(before)).toBe(true);
    },
  );
});
