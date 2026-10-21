import "../test-utils/prepare-compiled-subprocesses.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import * as tar from "tar";
import { expect, it } from "vitest";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { backupLocalCreateCommand, backupLocalRestoreCommand } from "../commands/backup-local.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { agentEngineSchema } from "../state/openclaw-agent-db-engine.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { openEngineStore, readEngineAnchor } from "./database-engine/open.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { recoverPendingDeliveries } from "./outbound/delivery-queue-recovery.js";
import { enqueueDelivery, loadUnfinishedDeliveries } from "./outbound/delivery-queue-storage.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

it("restores a native global/client checkpoint into an empty replacement state root", async () => {
  await withOpenClawTestState(
    { layout: "split", prefix: "local-checkpoint-proof-", scenario: "minimal" },
    async (state) => {
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      const localPath = resolveClientCredentialStorePath(state.env);
      const shared = openOpenClawStateDatabase({ env: state.env });
      shared.db.exec(
        "CREATE TABLE restart_witness(value TEXT); INSERT INTO restart_witness VALUES ('scheduler-and-approval-history-preserved')",
      );
      shared.db
        .prepare(
          "INSERT INTO state_leases(scope,lease_key,owner,created_at,updated_at) VALUES ('gateway-owner','global','departed-pod',1,1)",
        )
        .run();
      const material = generateStoredDeviceIdentity(1);
      const identity = {
        identity_key: "primary",
        device_id: material.deviceId,
        public_key_pem: material.publicKeyPem,
        private_key_pem: material.privateKeyPem,
        created_at_ms: 1,
        updated_at_ms: 1,
      };
      runClientCredentialOperation(state.env, { kind: "identity.create", identity });
      runClientCredentialOperation(state.env, {
        kind: "socket.ensure",
        fallback: {
          socket_key: "current",
          socket_path: "/synthetic/native.sock",
          socket_token: "synthetic-local-socket-secret",
          updated_at_ms: 1,
        },
        requested: { path: "/synthetic/native.sock", token: "synthetic-local-socket-secret" },
      });
      await closeOpenClawStateDatabaseAsync();
      const anchorPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      await fs.mkdir(state.agentDir(), { recursive: true });
      let anchorIdentity: unknown;
      {
        using anchor = openNodeSqliteDatabase(anchorPath);
        expect(() =>
          withEngineStoreAdmission(() =>
            openEngineStore({
              anchor,
              schema: agentEngineSchema,
              input: {
                connection: "postgresql://synthetic@127.0.0.1:1/unreachable?connect_timeout=1",
                schemaPrefix: "checkpoint",
              },
              prepareAnchor() {},
              inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
              openSqlite() {
                throw new Error("Expected PostgreSQL");
              },
            }),
          ),
        ).toThrow();
        anchorIdentity = readEngineAnchor(anchor);
        expect(anchorIdentity).toHaveLength(1);
      }
      const runtime = createTestRuntime();
      await state.writeConfig({
        database: {
          families: { agent: { engine: "postgres" } },
          postgres: {
            connection: "postgresql://synthetic@127.0.0.1:1/unreachable?connect_timeout=1",
          },
        },
      });
      const queueId = await enqueueDelivery(
        {
          channel: "checkpoint-test",
          to: "synthetic-recipient",
          payloads: [{ text: "Send only once" }],
          queuePolicy: "required",
        },
        state.stateDir,
      );
      expect(await loadUnfinishedDeliveries(state.stateDir)).toMatchObject([{ id: queueId }]);
      let sends = 0;
      const recovery = {
        cfg: {},
        stateDir: state.stateDir,
        deliver: async () => {
          sends += 1;
          return [];
        },
        log: { info() {}, warn() {}, error() {} },
      };
      const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
      const child = spawn(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(ownerUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { acquireGatewayStateOwner } from ${JSON.stringify(ownerUrl.href)};
         const owner = acquireGatewayStateOwner({ databasePath: process.argv[1], payload: { pid: process.pid, role: 'gateway', configPath: process.env.OPENCLAW_CONFIG_PATH, createdAt: new Date().toISOString() } });
         process.send({ ready: true });
         process.on('message', () => { owner.release(); process.disconnect(); });`,
          sharedPath,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const closed = once(child, "close");
      let artifact;
      try {
        const ready = await Promise.race([
          once(child, "message"),
          closed.then(() => {
            throw new Error("Foreign Gateway owner exited before readiness");
          }),
        ]);
        expect(ready[0]).toEqual({ ready: true });
        artifact = await backupLocalCreateCommand(runtime, {
          output: state.path("checkpoint.tar.gz"),
          json: true,
        });
        child.send({ release: true });
        expect(await closed).toEqual([0, null]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      }
      expect(await recoverPendingDeliveries(recovery)).toMatchObject({ recovered: 1 });
      expect(sends).toBe(1);
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
      expect(artifact.archivePath).toBe(state.path("checkpoint.tar.gz"));
      const extraction = state.path("archive-inspection");
      await fs.mkdir(extraction, { mode: 0o700 });
      await tar.extract({ file: artifact.archivePath, cwd: extraction });
      const manifestPath = `${extraction}/manifest.json`;
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const capturedShared = manifest.databases.find(
        (entry: { path: string }) => entry.path === sharedPath,
      );
      const capturedAnchor = manifest.databases.find(
        (entry: { path: string }) => entry.path === anchorPath,
      );
      expect(
        (
          await fs.readFile(
            `${extraction}/${manifest.databases.find((entry: { path: string }) => entry.path === localPath).image}`,
          )
        ).includes(Buffer.from("synthetic-local-socket-secret")),
      ).toBe(false);
      await expect(
        backupLocalRestoreCommand(runtime, artifact.archivePath, { json: true }),
      ).rejects.toThrow(/fresh database targets/);
      {
        using existing = openNodeSqliteDatabase(sharedPath, { readOnly: true });
        expect(existing.prepare("SELECT value FROM restart_witness").get()).toEqual({
          value: "scheduler-and-approval-history-preserved",
        });
      }
      expect(
        runClientCredentialOperation(state.env, { kind: "identity.read", identity_key: "primary" }),
      ).toEqual({ kind: "identity", identity });
      await closeOpenClawStateDatabaseAsync();
      for (const entry of manifest.databases) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const file = `${entry.path}${suffix}`;
          try {
            await fs.rename(file, `${file}.departed-pod`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        }
      }
      for (const mutation of ["path", "anchor", "engine"] as const) {
        const invalid = structuredClone(manifest);
        const target = invalid.databases.find(
          (entry: { path: string }) => entry.path === anchorPath,
        );
        if (mutation === "path") {
          target.path = state.path("unowned.sqlite");
        }
        if (mutation === "anchor") {
          target.localAnchor.storeId = "00000000-0000-4000-8000-000000000000";
        }
        if (mutation === "engine") {
          invalid.databases.find(
            (entry: { path: string }) => entry.path === sharedPath,
          ).localAnchor = target.localAnchor;
        }
        await fs.writeFile(manifestPath, JSON.stringify(invalid), { mode: 0o600 });
        const archivePath = state.path(`invalid-${mutation}.tar.gz`);
        await tar.create({ file: archivePath, gzip: true, cwd: extraction }, [
          "manifest.json",
          ...manifest.databases.map((entry: { image: string }) => entry.image),
        ]);
        await expect(
          backupLocalRestoreCommand(runtime, archivePath, { json: true }),
        ).rejects.toThrow(
          mutation === "path" ? /configured ownership/ : /engine identity does not match/,
        );
        await expect(fs.stat(sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(anchorPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(capturedAnchor.localAnchor).toBeDefined();
      await fs.rename(state.stateDir, state.path("departed-state"));
      await fs.mkdir(state.stateDir, { mode: 0o700 });
      expect(await fs.readdir(state.stateDir)).toEqual([]);
      const commandUrl = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.backupLocal);
      const restoredProcess = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(commandUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { backupLocalRestoreCommand } from ${JSON.stringify(commandUrl.href)};
           await backupLocalRestoreCommand({ log: console.log, error: console.error, exit(code) { process.exitCode = code; } }, process.argv[1], { json: true });`,
          artifact.archivePath,
        ],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: state.env.HOME,
          USERPROFILE: state.env.USERPROFILE,
          OPENCLAW_HOME: state.env.OPENCLAW_HOME,
          OPENCLAW_STATE_DIR: state.env.OPENCLAW_STATE_DIR,
          OPENCLAW_CONFIG_PATH: state.env.OPENCLAW_CONFIG_PATH,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          NO_COLOR: "1",
        },
      });
      expect(restoredProcess.code, restoredProcess.stdout + restoredProcess.stderr).toBe(0);
      const restoredResult = JSON.parse(restoredProcess.stdout);
      expect(restoredResult).toMatchObject({
        ok: true,
        archivePath: artifact.archivePath,
        stateDir: state.stateDir,
        databaseCount: 3,
      });
      expect(
        createHash("sha256")
          .update(await fs.readFile(sharedPath))
          .digest("hex"),
      ).toBe(capturedShared.sha256);
      using restoredAnchor = openNodeSqliteDatabase(anchorPath, { readOnly: true });
      expect(readEngineAnchor(restoredAnchor)).toEqual(anchorIdentity);
      expect(
        runClientCredentialOperation(state.env, { kind: "identity.read", identity_key: "primary" }),
      ).toEqual({ kind: "identity", identity });
      using restored = openNodeSqliteDatabase(sharedPath, { readOnly: true });
      expect(restored.prepare("SELECT * FROM state_leases").all()).toEqual([]);
      expect(restored.prepare("SELECT value FROM restart_witness").get()).toEqual({
        value: "scheduler-and-approval-history-preserved",
      });
      expect(await recoverPendingDeliveries(recovery)).toMatchObject({ recovered: 0 });
      expect(sends).toBe(1);
    },
  );
});
