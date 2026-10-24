import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { doctorDatabasePort as port } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.js";
import { capturePostgresBackup, readBackupEngine } from "../../snapshot/database-backup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  assertDatabasePortStartupAllowed,
  databasePortManifestPath,
} from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { agentPortProvider } from "./agent-port.js";
import * as fixtures from "./port-command.integration.test-support.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

describe.skipIf(!fixtures.connection)("family-scoped database port", () => {
  let state: OpenClawTestState;
  let client: Client;
  let workboard: string;
  let shared: string;
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const config = () => JSON.parse(fs.readFileSync(state.configPath, "utf8")) as OpenClawConfig;
  const interruptPublication = () => {
    const write = configIo.writeConfigFile;
    vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error("synthetic interruption after publication");
    });
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", prefix: "mixed-port-" });
    await state.writeConfig({
      database: { engine: "sqlite", postgres: { connection: fixtures.connection! } },
      plugins: { entries: { workboard: { enabled: false } } },
    });
    workboard = state.statePath("plugins", "workboard", "workboard.sqlite");
    shared = state.statePath("state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(workboard), { recursive: true });
    fixtures.seedPortSqlite(
      workboard,
      `${metadata.sqlite};
      INSERT INTO workboard_schema_migrations VALUES ('schema-3', 17);
      INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('mixed-board', 'retained board', 1, 2)`,
    );
    client = new Client({ connectionString: fixtures.connection });
    await client.connect();
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (state && client) {
      const directory = state.statePath("recovery", "database-port");
      await fixtures.dropPortSchemas(
        client,
        (await fixtures.files(directory)).filter(
          (file) =>
            path.basename(file) === "manifest.json" &&
            path.dirname(path.dirname(file)) === directory,
        ),
      );
    }
    await client?.end();
    await state?.cleanup();
  });

  it.each(["state", "workboard"] as const)(
    "round-trips %s with an unrelated PostgreSQL family",
    async (family) => {
      const other = family === "state" ? "workboard" : "state";
      const before = fixtures.canonical(workboard);
      const selectedPath = family === "state" ? shared : workboard;
      const otherPath = family === "state" ? workboard : shared;
      try {
        await port({ family: other, to: "postgres" });
        const untouched = hash(otherPath);
        await expect(port({ to: "postgres" })).rejects.toThrow("requires --family");
        const result = await port({ family, to: "postgres" });
        expect(result.stores).toEqual([selectedPath]);
        expect(hash(otherPath)).toBe(untouched);
        expect(config().database).toMatchObject({
          engine: "sqlite",
          families: {
            [family]: { engine: "postgres" },
            [other]: { engine: "postgres" },
          },
        });
        await port({ family, to: "sqlite" });
        expect(hash(otherPath)).toBe(untouched);
        expect(readBackupEngine(selectedPath).engine).toBe("sqlite");
        expect(config().database?.families).toEqual({ [other]: { engine: "postgres" } });
      } finally {
        await port({ family: other, to: "sqlite" });
        expect(config().database?.families).toBeUndefined();
        expect(fixtures.canonical(workboard)).toEqual(before);
      }
    },
    120_000,
  );

  it("recovers and backs up scoped PostgreSQL agents with SQLite state", async () => {
    const agent = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    const descriptor = await agentPortProvider.loadDescriptor();
    {
      using db = openNodeSqliteDatabase(agent);
      db.exec(descriptor.sqlite);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
        INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
        INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
        INSERT INTO cache_entries VALUES ('retained', 'sentinel', '"agent-data"', NULL, NULL, 1);`);
    }
    const unrelated = hash(workboard);
    interruptPublication();
    await expect(port({ family: "agent", to: "postgres" })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(readBackupEngine(agent).engine).toBe("postgres");
    expect(() => assertDatabasePortStartupAllowed(state.stateDir)).toThrow();
    await port({ resume: databasePortManifestPath(state.stateDir) });
    expect(() => assertDatabasePortStartupAllowed(state.stateDir)).not.toThrow();
    expect(config().database).toMatchObject({
      engine: "sqlite",
      families: { agent: { engine: "postgres" } },
    });
    expect(readBackupEngine(shared).engine).toBe("sqlite");
    const backup = await capturePostgresBackup({
      sourcePath: agent,
      directory: state.path("agent-backup"),
      profile: "exact",
      config: config(),
      assertCurrent() {},
    });
    expect(backup.source.owner).toBe("agent");
    await port({ family: "agent", to: "sqlite" });
    expect(config().database?.families).toBeUndefined();
    expect(readBackupEngine(shared).engine).toBe("sqlite");
    expect(hash(workboard)).toBe(unrelated);
    using db = openNodeSqliteDatabase(agent, { readOnly: true });
    const row = db.prepare("SELECT value_json FROM cache_entries WHERE scope = 'retained'").get();
    expect(row).toEqual({ value_json: '"agent-data"' });
  }, 120_000);

  describe("interrupted scoped publication", () => {
    beforeAll(async () => {
      await port({ family: "state", to: "postgres" });
    }, 120_000);
    afterAll(async () => {
      await port({ family: "state", to: "sqlite" });
    }, 120_000);

    it.each(["resume", "rollback"] as const)(
      "blocks startup and supports %s",
      async (action) => {
        const other = hash(shared);
        const before = fixtures.canonical(workboard);
        interruptPublication();
        const failure = await port({ family: "workboard", to: "postgres" }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        vi.restoreAllMocks();
        expect(readBackupEngine(workboard).engine, String(failure)).toBe("postgres");
        expect(() => assertDatabasePortStartupAllowed(state.stateDir)).toThrow();
        const active = databasePortManifestPath(state.stateDir);
        const inputsFile = fixtures
          .manifest(state)
          .artifacts.find((file) => path.basename(file.path) === "inputs.json");
        assert(inputsFile);
        expect(JSON.parse(fs.readFileSync(inputsFile.path, "utf8"))).toMatchObject({
          selection: {
            path: ["database", "families", "workboard", "engine"],
            originalValue: null,
            effectiveSource: "sqlite",
          },
        });
        await port({ [action]: active });
        expect(() => assertDatabasePortStartupAllowed(state.stateDir)).not.toThrow();
        expect(hash(shared)).toBe(other);
        expect(readBackupEngine(workboard).engine).toBe(
          action === "resume" ? "postgres" : "sqlite",
        );
        if (action === "resume") {
          await port({ family: "workboard", to: "sqlite" });
        }
        expect(fixtures.canonical(workboard)).toEqual(before);
      },
      120_000,
    );
  });
});
