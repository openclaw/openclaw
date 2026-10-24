import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { runClientCredentialOperation } from "../infra/client-credential-store.js";
import { databasePortManifestPath } from "../infra/database-port-recovery.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "../infra/device-identity-material.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  executeCanonicalStateSchema,
  writeCurrentStateSchemaMetadata,
} from "../state/openclaw-state-db-maintenance.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { type Context, refuse } from "./doctor-database-port-context.js";
import { doctorDatabasePort, type DatabasePortOptions } from "./doctor-database-port.js";

describe("database port engine-selection admission", () => {
  it.each([{ to: "postgres" }, { to: "sqlite", dryRun: true }] satisfies DatabasePortOptions[])(
    "requires a family for mixed installs before touching stores (%j)",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            engine: "sqlite",
            families: { workboard: { engine: "postgres" } },
            postgres: { connection: "postgres://synthetic.invalid/unused" },
          },
        });
        const database = await state.writeText("state/openclaw.sqlite", "retained state bytes");
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort(options)).rejects.toThrow(
          /Mixed-engine database port requires --family/,
        );
        expect(await fs.readFile(database, "utf8")).toBe("retained state bytes");
        expect(await fs.readFile(state.configPath)).toEqual(before);
        expect(await fs.readdir(state.statePath("state"))).toEqual(["openclaw.sqlite"]);
      });
    },
  );

  it.each(["sqlite", "postgres"] as const)(
    "keeps homogeneous %s no-op ports unchanged",
    async (engine) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: { engine, postgres: { connection: "postgres://synthetic.invalid/unused" } },
          plugins: { enabled: false },
        });
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort({ to: engine, dryRun: true })).resolves.toMatchObject({
          phase: "preflight",
          engine,
          stores: [],
        });
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );

  it.each([
    {
      database: { engine: "sqlite", families: { workboard: { engine: "sqlite" } } },
      to: "postgres",
    },
    {
      database: {
        engine: "sqlite",
        families: {
          state: { engine: "postgres" },
          workboard: { engine: "postgres" },
          logbook: { engine: "postgres" },
          "team-reports": { engine: "postgres" },
        },
      },
      to: "sqlite",
    },
  ] satisfies {
    database: NonNullable<OpenClawConfig["database"]>;
    to: DatabasePortOptions["to"];
  }[])(
    "refuses a global port that cannot move the pinned family selection (%j)",
    async ({ database, to }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            ...database,
            postgres: { connection: "postgres://synthetic.invalid/unused" },
          },
          plugins: { enabled: false },
        });
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort({ to, dryRun: true })).rejects.toThrow(
          /requires --family|require --family/,
        );
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );
});

describe("database port local credential companion", () => {
  it("explains a local credential receipt bound to a replaced state file", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        database: { postgres: { connection: "postgres://synthetic.invalid/unused" } },
        plugins: { enabled: false },
      });
      runClientCredentialOperation(state.env, {
        kind: "identity.create",
        identity: storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(1), 1),
      });
      const sharedPath = await state.writeText("state/openclaw.sqlite", "");
      {
        using shared = openNodeSqliteDatabase(sharedPath);
        runSqliteImmediateTransactionSync(shared, () => {
          executeCanonicalStateSchema(shared, { includeVersionLazyAdditiveTables: true });
          writeCurrentStateSchemaMetadata(shared, 1);
          bindFreshClientCredentialStore(shared, { path: sharedPath, env: state.env });
        });
      }
      // A tar-extracted copy keeps the bytes but gets a new inode.
      await fs.copyFile(sharedPath, `${sharedPath}.copy`);
      await fs.rename(`${sharedPath}.copy`, sharedPath);

      await expect(
        doctorDatabasePort({ to: "postgres", family: "state", dryRun: true }),
      ).rejects.toThrow(
        /observed a local credential receipt not bound to this state database file; required a complete local credential receipt for this exact state database file; restore archives with openclaw backup restore\. Stop the Gateway first; correct this fact and retry\.$/,
      );
    });
  });
});

describe("database port refusal recovery hint", () => {
  it("offers --resume/--rollback only when a recovery manifest exists", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const ctx = { phase: "preflight", target: "store", stateDir: state.stateDir } as Context;
      const manifestPath = databasePortManifestPath(state.stateDir);
      expect(() => refuse(ctx, "fact", "other fact")).toThrow(/retry\.$/);
      await state.writeText(path.relative(state.stateDir, manifestPath), "{}");
      expect(() => refuse(ctx, "fact", "other fact")).toThrow(
        `retry, or use --resume/--rollback with ${manifestPath}.`,
      );
    });
  });
});
