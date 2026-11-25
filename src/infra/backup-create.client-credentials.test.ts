import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupCase, restoreBackup } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { writeClientCredentialReceipt } from "./client-credential-readiness.js";
import { emptyClientCredentialReceipt } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { runClientCredentialOperation } from "./client-credential-store.js";

it(
  "backs up committed local credentials without retaining socket authentication",
  backupCase({ layout: "split", prefix: "backup-client-credentials-" })(async (state) => {
    const pathname = state.statePath("client", "credentials.sqlite");
    await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
    await fs.writeFile(state.statePath("client", "notes.txt"), "synthetic client note");
    using source = new DatabaseSync(pathname);
    await fs.chmod(pathname, 0o600);
    source.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    source.exec(CLIENT_CREDENTIAL_SCHEMA_SQL);
    source.exec("PRAGMA user_version = 1");
    writeClientCredentialReceipt(source, emptyClientCredentialReceipt(), "complete");
    source.exec(`
      INSERT INTO device_identities (identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms)
        VALUES ('node', 'synthetic-device', 'synthetic-public-key', 'synthetic-private-key', 123, 456);
      INSERT INTO gateway_origin_device_tokens (gateway_scope, device_id, role, token, scopes_json, updated_at_ms)
        VALUES ('synthetic-gateway', 'synthetic-device', 'operator', 'synthetic-cached-token', '["operator.read"]', 789);
      INSERT INTO native_exec_socket_credentials (socket_key, socket_path, socket_token, updated_at_ms)
        VALUES ('current', '/synthetic/native.sock', 'synthetic-socket-secret', 456);
    `);
    // Capture the independent source before the backup transforms the destination.
    const preserved = ["device_identities", "gateway_origin_device_tokens"].map((table) => ({
      table,
      rows: source.prepare(`SELECT * FROM ${table}`).all(),
    }));
    expect((await fs.stat(`${pathname}-wal`)).size).toBeGreaterThan(0);
    const backup = await createBackupArchive({
      output: state.path("backup.tar.gz"),
      includeWorkspace: false,
    });
    const restored = await restoreBackup(state, backup);
    const asset = backup.assets.find((entry) => entry.kind === "state");
    expect(asset).toBeDefined();
    const restoredStateDir = path.join(restored.targetPath, asset!.archivePath);
    const restoredPath = path.join(restoredStateDir, "client", "credentials.sqlite");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(restoredPath))).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(path.dirname(restoredPath), "notes.txt"), "utf8")).toBe(
      "synthetic client note",
    );
    {
      using recovered = new DatabaseSync(restoredPath, { readOnly: true });
      expect(recovered.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      for (const { table, rows } of preserved) {
        expect(recovered.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      }
      expect(recovered.prepare("SELECT * FROM native_exec_socket_credentials").all()).toEqual([
        {
          socket_key: "current",
          socket_path: "/synthetic/native.sock",
          socket_token: null,
          updated_at_ms: 456,
        },
      ]);
    }
    expect((await fs.readFile(restoredPath)).includes(Buffer.from("synthetic-socket-secret"))).toBe(
      false,
    );
    const sourceToken = source
      .prepare("SELECT socket_token FROM native_exec_socket_credentials")
      .get();
    expect(sourceToken).toEqual({ socket_token: "synthetic-socket-secret" });
    const restoredEnv = { ...state.env, OPENCLAW_STATE_DIR: restoredStateDir };
    const replacement = {
      socket_key: "current" as const,
      socket_path: "/synthetic/restored.sock",
      socket_token: "synthetic-restored-secret",
      updated_at_ms: 999,
    };
    expect(
      runClientCredentialOperation(restoredEnv, {
        kind: "socket.ensure",
        fallback: replacement,
        requested: { path: replacement.socket_path, token: replacement.socket_token },
      }),
    ).toEqual({ kind: "socket", socket: replacement });
    expect(runClientCredentialOperation(restoredEnv, { kind: "socket.read" })).toEqual({
      kind: "socket",
      socket: replacement,
    });
  }),
);
