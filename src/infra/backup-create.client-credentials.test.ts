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
import { withClientCredentialStore } from "./client-credential-store.test-support.js";

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
    const identity = {
      identity_key: "node",
      device_id: "synthetic-device",
      public_key_pem: "synthetic-public-key",
      private_key_pem: "synthetic-private-key",
      created_at_ms: 123,
      updated_at_ms: 456,
    };
    const token = {
      gateway_scope: "synthetic-gateway",
      device_id: "synthetic-device",
      role: "operator",
      token: "synthetic-cached-token",
      scopes_json: '["operator.read"]',
      updated_at_ms: 789,
    };
    const socket = {
      socket_key: "current",
      socket_path: "/synthetic/native.sock",
      socket_token: "synthetic-socket-secret",
      updated_at_ms: 456,
    };
    for (const [table, row] of Object.entries({
      device_identities: identity,
      gateway_origin_device_tokens: token,
      native_exec_socket_credentials: socket,
    })) {
      source
        .prepare(
          `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(row));
    }
    expect((await fs.stat(`${pathname}-wal`)).size).toBeGreaterThan(0);
    const backup = await createBackupArchive({
      output: state.path("backup.tar.gz"),
      includeWorkspace: false,
    });
    const restored = await restoreBackup(state, backup);
    const asset = backup.assets.find((entry) => entry.kind === "state");
    expect(asset).toBeDefined();
    const restoredPath = path.join(
      restored.targetPath,
      asset!.archivePath,
      "client",
      "credentials.sqlite",
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(restoredPath))).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(path.dirname(restoredPath), "notes.txt"), "utf8")).toBe(
      "synthetic client note",
    );
    {
      using recovered = new DatabaseSync(restoredPath, { readOnly: true });
      expect(recovered.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(recovered.prepare("SELECT * FROM device_identities").all()).toEqual([identity]);
      expect(recovered.prepare("SELECT * FROM gateway_origin_device_tokens").all()).toEqual([
        token,
      ]);
      expect(recovered.prepare("SELECT * FROM native_exec_socket_credentials").all()).toEqual([
        { ...socket, socket_token: null },
      ]);
    }
    expect((await fs.readFile(restoredPath)).includes(Buffer.from("synthetic-socket-secret"))).toBe(
      false,
    );
    expect(source.prepare("SELECT socket_token FROM native_exec_socket_credentials").get()).toEqual(
      {
        socket_token: "synthetic-socket-secret",
      },
    );
    const restoredEnv = {
      ...state.env,
      OPENCLAW_STATE_DIR: path.join(restored.targetPath, asset!.archivePath),
    };
    expect(withClientCredentialStore(restoredEnv, false, () => true)).toBe(true);
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
