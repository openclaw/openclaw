import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { discoverBackupDatabasePaths } from "../backup-sqlite-snapshot.js";
import { resolveClientCredentialStorePath } from "../client-credential-paths.js";
import * as credentials from "../client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../client-credential-receipt.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "../client-credential-store.js";
import * as recovery from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";

const config = {
  database: { engine: "sqlite" as const },
  plugins: { entries: { matrix: { enabled: false } } },
};
const key = { device_id: "synthetic-device", role: "operator" };
type Store = { env: NodeJS.ProcessEnv; shared: string; local: string; token: string };

async function fixture(run: (state: OpenClawTestState, stores: Store[]) => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "port-local-credentials-" },
    async (state) => {
      await state.writeConfig(config);
      const roots = [
        state.stateDir,
        state.statePath("matrix", "accounts", "active", "matrix.example__user", "0123456789abcdef"),
      ];
      const stores: Store[] = [];
      try {
        for (const [index, root] of roots.entries()) {
          const env = { ...state.env, OPENCLAW_STATE_DIR: root };
          const { path: shared } = openOpenClawStateDatabase({ env });
          stores.push({
            env,
            shared,
            local: resolveClientCredentialStorePath(env),
            token: `synthetic-local-token-${index}`,
          });
        }
        await closeOpenClawStateDatabaseAsync();
        for (const store of stores) {
          runClientCredentialOperation(store.env, {
            kind: "token.replace",
            key,
            token: {
              ...key,
              token: store.token,
              scopes_json: '["operator.read"]',
              updated_at_ms: 1,
            },
          });
        }
        await run(state, stores);
      } finally {
        vi.restoreAllMocks();
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
}

function expectReady(store: Store) {
  expect(runClientCredentialOperation(store.env, { kind: "token.read", key })).toMatchObject({
    kind: "token",
    token: { token: store.token },
  });
  using owner = openClientCredentialCustody(store.env);
  assert(owner);
  expect(credentials.readClientCredentialReceipt(owner.database)).toMatchObject({
    phase: "complete",
    receipt: { sharedFile: readClientCredentialFileIdentity(store.shared) },
  });
  owner.close();
  expect(readBackupEngine(store.local)).toEqual({ engine: "sqlite" });
}

function bytes(state: OpenClawTestState, stores: Store[], extraFiles: string[] = []) {
  return [
    state.configPath,
    ...stores.flatMap((store) => [store.shared, store.local]),
    ...extraFiles,
  ].map((file) => fs.readFileSync(file));
}

async function expectRefusal(state: OpenClawTestState, stores: Store[], file: string) {
  const before = bytes(state, stores, [file]);
  await expect(doctorDatabasePort({ family: "state", to: "sqlite", dryRun: true })).rejects.toThrow(
    file,
  );
  expect(bytes(state, stores, [file])).toEqual(before);
  expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
}

describe("database port local credential ownership", () => {
  it("explains a copied state file's receipt mismatch without offering nonexistent recovery", async () => {
    await fixture(async (state, stores) => {
      await state.writeConfig({
        ...config,
        database: { postgres: { connection: "postgres://synthetic.invalid/unused" } },
      });
      const store = stores[0]!;
      const original = fs.statSync(store.shared, { bigint: true });
      fs.copyFileSync(store.shared, `${store.shared}.copy`);
      fs.renameSync(`${store.shared}.copy`, store.shared);
      expect(fs.statSync(store.shared, { bigint: true }).ino).not.toBe(original.ino);
      const before = bytes(state, stores);
      await expect(
        doctorDatabasePort({ family: "state", to: "postgres", dryRun: true }),
      ).rejects.toMatchObject({
        message: `Database port preflight: ${store.local}; Database port credentials do not match the captured shared database. Restore the archive with openclaw backup restore before retrying.`,
      });
      expect(bytes(state, stores)).toEqual(before);
      expect(fs.existsSync(state.statePath("recovery"))).toBe(false);
    });
  });

  it("keeps bound companions in backup and out of portable state without changing a dry run", async () => {
    await fixture(async (state, stores) => {
      const before = bytes(state, stores);
      const result = await doctorDatabasePort({ family: "state", to: "sqlite", dryRun: true });
      expect(result.stores.toSorted()).toEqual(stores.map((store) => store.shared).toSorted());
      expect(result.remainingSqlite.toSorted()).toEqual(
        stores.map((store) => store.local).toSorted(),
      );
      expect(result.outOfScope).toEqual(
        expect.arrayContaining(stores.map((store) => ({ path: store.local, engine: "sqlite" }))),
      );
      const discovered = await discoverBackupDatabasePaths({
        stateDir: state.stateDir,
        env: state.env,
        config,
      });
      expect(discovered).toEqual(
        expect.arrayContaining(stores.flatMap((store) => [store.shared, store.local])),
      );
      expect(bytes(state, stores)).toEqual(before);
      for (const store of stores) {
        expectReady(store);
      }
    });
  });

  it.each(["unassociated", "companion"] as const)(
    "refuses an unknown %s credentials.sqlite",
    async (placement) => {
      await fixture(async (state, stores) => {
        const file =
          placement === "companion"
            ? stores[1]!.local
            : state.statePath("matrix", "unrelated", "client", "credentials.sqlite");
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (placement === "companion") {
          fs.unlinkSync(file);
        }
        {
          using db = openNodeSqliteDatabase(file);
          db.exec("CREATE TABLE unrelated (value TEXT)");
        }
        fs.chmodSync(file, 0o600);
        await expectRefusal(state, stores, file);
      });
    },
  );

  it("refuses a companion bound to another shared root before publication", async () => {
    await fixture(async (state, stores) => {
      using owner = openClientCredentialCustody(stores[1]!.env, { migration: true });
      assert(owner);
      const stored = credentials.readClientCredentialReceipt(owner.database);
      assert(stored);
      stored.receipt.sharedFile = readClientCredentialFileIdentity(stores[0]!.shared);
      owner.transaction(() =>
        credentials.writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
      );
      owner.close();
      await expectRefusal(state, stores, stores[1]!.local);
    });
  });
});
