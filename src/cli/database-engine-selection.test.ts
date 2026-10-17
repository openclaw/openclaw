import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliDatabaseEngine } from "./database-engine-selection.js";

afterEach(resetDatabaseEngineSelectionForTest);

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
});
