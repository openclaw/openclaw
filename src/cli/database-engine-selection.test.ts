import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseEngineAdapters } from "../infra/database-engine/adapters.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareCliDatabaseEngine } from "./database-engine-selection.js";

beforeEach(() => {
  resetDatabaseEngineSelectionForTest();
});

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
});

async function expectUnselected(state: OpenClawTestState) {
  expect(getDatabaseEngineSelection()).toBeUndefined();
  await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

const prepare = (...args: string[]) => prepareCliDatabaseEngine(["node", "openclaw", ...args]);
const commands = (...groups: string[]) =>
  groups.flatMap((group) => group.split("|").map((command) => (command ? command.split(" ") : [])));
const withState = (run: (state: OpenClawTestState) => Promise<void>, env: NodeJS.ProcessEnv = {}) =>
  withOpenClawTestState({ label: "cli-engine-selection", env }, run);

const database = {
  engine: "postgres",
  postgres: {
    connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_CLI_DSN" },
    schemaPrefix: "cli_selection",
  },
};

const recoveryOwnerCommands = commands(
  "|onboard --reset|onboard --reset --reset-scope config --agent-name main",
  "onboard --reset --non-interactive --accept-risk|setup --wizard --reset",
  "setup --wizard --reset --reset-scope config|agent --agent main --message hello",
  "gateway restart|daemon restart|node restart|gateway stop --force|daemon stop --force",
  "gateway uninstall|daemon uninstall|node stop|node uninstall|node status",
  "cron status|automations list|devices list|nodes status|nodes camera snap|secrets reload",
  "approvals pending|exec-approvals pending|memory status|memory search fixture|memory session-backfill",
  "claws build|update|update --dry-run|update --channel beta|update status --json",
  "update repair|update finalize|update wizard|update migration-plan --snapshot-state /selected/state",
  "reset --scope config|reset --scope=config|reset --scope=full --scope=config",
  "uninstall --service|uninstall --service --app",
);

describe("one-shot CLI engine selection", () => {
  it.each([["models", "list"], ["onboard"], ["setup", "--wizard"], ["crestodian"]])(
    "selects the config-directed target for %j without opening a database",
    async (...args) => {
      await withState(
        async (state) => {
          const target = state.path("selected.json");
          await fs.writeFile(target, JSON.stringify({ database, plugins: { enabled: false } }));
          await state.writeConfig({
            env: { vars: { OPENCLAW_CONFIG_PATH: target } },
            plugins: { enabled: false },
          });
          delete process.env.OPENCLAW_CONFIG_PATH;
          await prepare(...args);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(target);
          expect(getDatabaseEngineSelection()).toMatchObject({
            effectiveEngines: { state: "postgres", agent: "postgres" },
            postgres: {
              connection: "postgresql://127.0.0.1:1/test",
              schemaPrefix: "cli_selection",
            },
          });
          await expect(
            fs.access(state.statePath("state", "openclaw.sqlite")),
          ).rejects.toMatchObject({
            code: "ENOENT",
          });
        },
        { OPENCLAW_TEST_CLI_DSN: "postgresql://127.0.0.1:1/test" },
      );
    },
  );

  it.each<[string, string[]?, string?, string?]>([
    ["root"],
    ["recommendation", ["onboard", "--json", "recommendations"]],
    ["recommendation mutation", ["onboard", "recommendations", "refresh"]],
    ["include"],
    ["missing include", undefined, "CONFIG_READ_FAILED", "Config could not be read at"],
  ])(
    "preserves %s failure diagnostics before selecting storage",
    async (
      source,
      args = ["models", "list"],
      code = "INVALID_CONFIG",
      heading = "Invalid config at",
    ) => {
      await withState(async (state) => {
        const raw = source.includes("include")
          ? '{"$include":"included.json"}'
          : "{ invalid config";
        await fs.writeFile(state.configPath, raw);
        if (source === "include") {
          await fs.writeFile(state.statePath("included.json"), "{ invalid config");
        }

        await expect(prepare(...args)).rejects.toMatchObject({
          code,
          message: expect.stringContaining(`${heading} ${state.configPath}:\n`),
        });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
        await expectUnselected(state);
      });
    },
  );

  it.each(
    [
      ...commands(
        "--help|--version|logs|channels logs|config file|config validate --json",
        "gateway status --runtime-intent-only --json|daemon status --runtime-intent-only --json",
        "gateway discover|gateway call health|gateway health|gateway suspend",
        "gateway resume synthetic-suspension|gateway usage-cost|gateway stability|channels status",
        "plugins build|plugins lint|completion|config set database.postgres.connection.id REPAIRED_DSN",
        "config patch --stdin|config unset database|gateway run|gateway --dev --reset",
        "doctor --session-sqlite inspect --session-sqlite-store /selected/store",
        "doctor --post-upgrade|doctor --client-credentials --repair --non-interactive",
        "update admit --context /selected/context|update migrate|update restore|update finish",
        "update recover|update adopt-immutable|update --channel -- cleanup",
      ),
      ...recoveryOwnerCommands,
    ].map((args) => ({ args })),
  )("leaves $args with its existing target owner", async ({ args }) => {
    await withState(async (state) => {
      await state.writeConfig({ database, plugins: { enabled: false } });
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      await prepare(...args);
      await expectUnselected(state);
    });
  });

  it.each(recoveryOwnerCommands.map((args) => ({ args })))(
    "keeps malformed source diagnostics with the $args owner",
    async ({ args }) => {
      await withState(async (state) => {
        await fs.writeFile(state.configPath, '{"database":{"engine":"postgres"}, broken');
        expect(await prepare(...args)).toBe(false);
        await expectUnselected(state);
      });
    },
  );

  it.each(
    commands(
      "agent --local --agent main --message hello|nodes custom-plugin-command|memory custom-plugin-command",
      "reset --scope full|reset --scope=config+creds+sessions|reset --scope=config --scope=full",
      "reset -- --scope config|uninstall --service --state|uninstall --service --workspace",
      "uninstall --service --all|uninstall -- --service",
    ).map((args) => ({ args })),
  )("still selects state for broader cleanup $args", async ({ args }) => {
    await withState(async (state) => {
      await state.writeConfig({ database, plugins: { enabled: false } });
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      await expect(prepare(...args)).rejects.toThrow("SecretRef is unresolved");
      await expectUnselected(state);
    });
  });

  it.each([
    { engine: "sqlite", source: "root" },
    { engine: "postgres", source: "root" },
    { engine: "sqlite", source: "include" },
    { engine: "postgres", source: "include" },
  ])(
    "does not open existing storage while Doctor cannot parse $engine $source config",
    async ({ engine, source }) => {
      await withState(async (state) => {
        if (source === "include") {
          await fs.writeFile(
            state.configPath,
            JSON.stringify({ database: { engine }, $include: "broken.json" }),
          );
          await fs.writeFile(state.statePath("broken.json"), "{broken json");
        } else {
          await fs.writeFile(state.configPath, `{"database":{"engine":"${engine}"}, broken`);
        }
        const databasePath = state.statePath("state", "openclaw.sqlite");
        await fs.mkdir(state.statePath("state"), { recursive: true });
        await fs.writeFile(databasePath, "unopened synthetic store");
        const sqliteOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
        const postgresOpen = vi.spyOn(databaseEngineAdapters.postgres, "openConnection");
        expect(await prepare("doctor", "--non-interactive", "--json")).toBe(true);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        expect(sqliteOpen).not.toHaveBeenCalled();
        expect(postgresOpen).not.toHaveBeenCalled();
        expect(await fs.readFile(databasePath, "utf8")).toBe("unopened synthetic store");
      });
    },
  );

  it("keeps updater-owned Doctor selection with its result receipt", async () => {
    await withState(
      async (state) => {
        await state.writeConfig({ database, plugins: { enabled: false } });
        delete process.env.OPENCLAW_TEST_CLI_DSN;
        expect(await prepare("doctor")).toBe(false);
        expect(getDatabaseEngineSelection()).toBeUndefined();
      },
      { OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: "-" },
    );
  });

  it("leaves malformed config untouched for the local credential owner", async () => {
    await withState(async (state) => {
      const raw = '{"database":{"engine":"postgres"}, broken';
      await fs.writeFile(state.configPath, raw);
      expect(await prepare("doctor", "--client-credentials", "--repair", "--non-interactive")).toBe(
        false,
      );
      expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
      await expectUnselected(state);
    });
  });

  it("keeps storage unopened when prefix repair leaves a PostgreSQL credential unresolved", async () => {
    await withState(async (state) => {
      const config = { database, plugins: { enabled: false } };
      await fs.writeFile(state.configPath, `synthetic warning\n${JSON.stringify(config)}\n`);
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      const sqliteOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const postgresOpen = vi.spyOn(databaseEngineAdapters.postgres, "openConnection");
      expect(
        // Handoff lock journals are temp-scoped; do not borrow another test's ledger.
        await withEnvAsync({ TMPDIR: state.root, TMP: state.root, TEMP: state.root }, () =>
          prepare("doctor", "--fix", "--non-interactive"),
        ),
      ).toBe(true);
      expect(getDatabaseEngineSelection()).toBeUndefined();
      expect(sqliteOpen).not.toHaveBeenCalled();
      expect(postgresOpen).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
    });
  });
});
