import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { writeClientCredentialReceipt } from "./client-credential-readiness.js";
import { emptyClientCredentialReceipt } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { withClientCredentialStore } from "./client-credential-store.test-support.js";

it("backs up committed local credentials without retaining socket authentication", async () => {
  await withOpenClawTestState(
    { layout: "split", prefix: "backup-client-credentials-", scenario: "minimal" },
    async (state) => {
      const pathname = state.statePath("client", "credentials.sqlite");
      await fs.mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
      await fs.writeFile(state.statePath("client", "notes.txt"), "synthetic client note");
      using source = new DatabaseSync(pathname);
      await fs.chmod(pathname, 0o600);
      source.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      source.exec(CLIENT_CREDENTIAL_SCHEMA_SQL);
      source.exec("PRAGMA user_version = 1");
      writeClientCredentialReceipt(source, emptyClientCredentialReceipt(), "complete");
      source
        .prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)")
        .run("node", "synthetic-device", "synthetic-public-key", "synthetic-private-key", 123, 456);
      source
        .prepare("INSERT INTO gateway_origin_device_tokens VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "synthetic-gateway",
          "synthetic-device",
          "operator",
          "synthetic-cached-token",
          '["operator.read"]',
          789,
        );
      source
        .prepare("INSERT INTO native_exec_socket_credentials VALUES (?, ?, ?, ?)")
        .run("current", "/synthetic/native.sock", "synthetic-socket-secret", 456);
      expect((await fs.stat(`${pathname}-wal`)).size).toBeGreaterThan(0);
      const backup = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        includeWorkspace: false,
      });
      const restored = await backupRestoreCommand(createTestRuntime(), {
        archive: backup.archivePath,
        target: state.path("restored"),
      });
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
        expect(recovered.prepare("SELECT * FROM device_identities").all()).toEqual([
          {
            identity_key: "node",
            device_id: "synthetic-device",
            public_key_pem: "synthetic-public-key",
            private_key_pem: "synthetic-private-key",
            created_at_ms: 123,
            updated_at_ms: 456,
          },
        ]);
        expect(recovered.prepare("SELECT * FROM gateway_origin_device_tokens").all()).toEqual([
          {
            gateway_scope: "synthetic-gateway",
            device_id: "synthetic-device",
            role: "operator",
            token: "synthetic-cached-token",
            scopes_json: '["operator.read"]',
            updated_at_ms: 789,
          },
        ]);
        expect(recovered.prepare("SELECT * FROM native_exec_socket_credentials").all()).toEqual([
          {
            socket_key: "current",
            socket_path: "/synthetic/native.sock",
            socket_token: null,
            updated_at_ms: 456,
          },
        ]);
      }
      expect(
        (await fs.readFile(restoredPath)).includes(Buffer.from("synthetic-socket-secret")),
      ).toBe(false);
      expect(
        source.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
      ).toEqual({
        socket_token: "synthetic-socket-secret",
      });
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
    },
  );
});
