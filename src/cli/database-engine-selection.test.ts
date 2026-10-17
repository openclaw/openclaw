import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseEngineAdapters } from "../infra/database-engine/adapters.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliDatabaseEngine } from "./database-engine-selection.js";

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
});

const database = {
  engine: "postgres",
  postgres: {
    connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_CLI_DSN" },
    schemaPrefix: "cli_selection",
  },
};

describe("one-shot CLI engine selection", () => {
  it("selects the config-directed target without opening a database", async () => {
    await withOpenClawTestState(
      {
        label: "cli-engine-selection",
        env: { OPENCLAW_TEST_CLI_DSN: "postgresql://127.0.0.1:1/test" },
      },
      async (state) => {
        const target = state.path("selected.json");
        await fs.writeFile(target, JSON.stringify({ database, plugins: { enabled: false } }));
        await state.writeConfig({
          env: { vars: { OPENCLAW_CONFIG_PATH: target } },
          plugins: { enabled: false },
        });
        delete process.env.OPENCLAW_CONFIG_PATH;
        await prepareCliDatabaseEngine(["node", "openclaw", "models", "list"]);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBe(target);
        expect(getDatabaseEngineSelection()).toMatchObject({
          effectiveEngines: { state: "postgres", agent: "postgres" },
          postgres: { connection: "postgresql://127.0.0.1:1/test", schemaPrefix: "cli_selection" },
        });
        await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  });

  it.each(
    [
      ["--help"],
      ["--version"],
      ["logs"],
      ["channels", "logs"],
      ["config", "file"],
      ["plugins", "build"],
      ["completion"],
      ["config", "set", "database.postgres.connection.id", "REPAIRED_DSN"],
      ["config", "patch", "--stdin"],
      ["config", "unset", "database"],
      ["gateway", "run"],
      ["gateway", "--dev", "--reset"],
      ["doctor", "--session-sqlite", "inspect", "--session-sqlite-store", "/selected/store"],
      ["doctor", "--post-upgrade"],
      ["update", "admit", "--context", "/selected/context"],
      ["update", "migrate"],
      ["update", "restore"],
      ["update", "finish"],
      ["update", "recover"],
      ["update", "adopt-immutable"],
      ["update", "--channel", "--", "cleanup"],
    ].map((args) => ({ args })),
  )("leaves $args with its existing target owner", async ({ args }) => {
    await withOpenClawTestState({ label: "cli-engine-deferred" }, async (state) => {
      await state.writeConfig({ database, plugins: { enabled: false } });
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      await prepareCliDatabaseEngine(["node", "openclaw", ...args]);
      expect(getDatabaseEngineSelection()).toBeUndefined();
      await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it.each(["sqlite", "postgres"])(
    "does not open existing storage while Doctor cannot parse %s config",
    async (engine) => {
      await withOpenClawTestState({ label: "doctor-unresolved-engine" }, async (state) => {
        await fs.writeFile(state.configPath, `{"database":{"engine":"${engine}"}, broken`);
        const databasePath = state.statePath("state", "openclaw.sqlite");
        await fs.mkdir(state.statePath("state"), { recursive: true });
        await fs.writeFile(databasePath, "unopened synthetic store");
        const sqliteOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
        const postgresOpen = vi.spyOn(databaseEngineAdapters.postgres, "openConnection");
        expect(
          await prepareCliDatabaseEngine([
            "node",
            "openclaw",
            "doctor",
            "--non-interactive",
            "--json",
          ]),
        ).toBe(true);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        expect(sqliteOpen).not.toHaveBeenCalled();
        expect(postgresOpen).not.toHaveBeenCalled();
        expect(await fs.readFile(databasePath, "utf8")).toBe("unopened synthetic store");
      });
    },
  );

  it("keeps updater-owned Doctor selection with its result receipt", async () => {
    await withOpenClawTestState(
      {
        label: "doctor-update-selection",
        env: { OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: "-" },
      },
      async (state) => {
        await state.writeConfig({ database, plugins: { enabled: false } });
        delete process.env.OPENCLAW_TEST_CLI_DSN;
        expect(await prepareCliDatabaseEngine(["node", "openclaw", "doctor"])).toBe(false);
        expect(getDatabaseEngineSelection()).toBeUndefined();
      },
    );
  });

  it("keeps storage unopened when prefix repair leaves a PostgreSQL credential unresolved", async () => {
    await withOpenClawTestState({ label: "doctor-repaired-unresolved-engine" }, async (state) => {
      const config = { database, plugins: { enabled: false } };
      await fs.writeFile(state.configPath, `synthetic warning\n${JSON.stringify(config)}\n`);
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      const sqliteOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const postgresOpen = vi.spyOn(databaseEngineAdapters.postgres, "openConnection");
      expect(
        await prepareCliDatabaseEngine([
          "node",
          "openclaw",
          "doctor",
          "--fix",
          "--non-interactive",
        ]),
      ).toBe(true);
      expect(getDatabaseEngineSelection()).toBeUndefined();
      expect(sqliteOpen).not.toHaveBeenCalled();
      expect(postgresOpen).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
    });
  });
});
