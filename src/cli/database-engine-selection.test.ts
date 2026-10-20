import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseEngineAdapters } from "../infra/database-engine/adapters.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliDatabaseEngine } from "./database-engine-selection.js";

beforeEach(() => {
  resetDatabaseEngineSelectionForTest();
});

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

const recoveryOwnerCommands = [
  [],
  ["onboard", "--reset"],
  ["onboard", "--reset", "--reset-scope", "config", "--agent-name", "main"],
  ["onboard", "--reset", "--non-interactive", "--accept-risk"],
  ["setup", "--wizard", "--reset"],
  ["setup", "--wizard", "--reset", "--reset-scope", "config"],
  ["agent", "--agent", "main", "--message", "hello"],
  ["gateway", "restart"],
  ["daemon", "restart"],
  ["node", "restart"],
  ["gateway", "stop", "--force"],
  ["daemon", "stop", "--force"],
  ["gateway", "uninstall"],
  ["daemon", "uninstall"],
  ["node", "stop"],
  ["node", "uninstall"],
  ["node", "status"],
  ["cron", "status"],
  ["automations", "list"],
  ["devices", "list"],
  ["nodes", "status"],
  ["nodes", "camera", "snap"],
  ["secrets", "reload"],
  ["approvals", "pending"],
  ["exec-approvals", "pending"],
  ["memory", "status"],
  ["memory", "search", "fixture"],
  ["memory", "session-backfill"],
  ["claws", "build"],
  ["update"],
  ["update", "--dry-run"],
  ["update", "--channel", "beta"],
  ["update", "status", "--json"],
  ["update", "repair"],
  ["update", "finalize"],
  ["update", "wizard"],
  ["update", "migration-plan", "--snapshot-state", "/selected/state"],
  ["reset", "--scope", "config"],
  ["reset", "--scope=config"],
  ["reset", "--scope=full", "--scope=config"],
  ["uninstall", "--service"],
  ["uninstall", "--service", "--app"],
];

describe("one-shot CLI engine selection", () => {
  it.each([["models", "list"], ["onboard"], ["setup", "--wizard"], ["crestodian"]])(
    "selects the config-directed target for %j without opening a database",
    async (...args) => {
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
          await prepareCliDatabaseEngine(["node", "openclaw", ...args]);
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
      );
    },
  );

  it.each([
    { source: "root", code: "INVALID_CONFIG", heading: "Invalid config at" },
    {
      source: "recommendation",
      code: "INVALID_CONFIG",
      heading: "Invalid config at",
      args: ["onboard", "--json", "recommendations"],
    },
    {
      source: "recommendation mutation",
      code: "INVALID_CONFIG",
      heading: "Invalid config at",
      args: ["onboard", "recommendations", "refresh"],
    },
    { source: "include", code: "INVALID_CONFIG", heading: "Invalid config at" },
    {
      source: "missing include",
      code: "CONFIG_READ_FAILED",
      heading: "Config could not be read at",
    },
  ])(
    "preserves $source failure diagnostics before selecting storage",
    async ({ source, code, heading, args }) => {
      await withOpenClawTestState({ label: "cli-engine-invalid-source" }, async (state) => {
        const raw = source.includes("include")
          ? '{"$include":"included.json"}'
          : "{ invalid config";
        await fs.writeFile(state.configPath, raw);
        if (source === "include") {
          await fs.writeFile(state.statePath("included.json"), "{ invalid config");
        }

        await expect(
          prepareCliDatabaseEngine(["node", "openclaw", ...(args ?? ["models", "list"])]),
        ).rejects.toMatchObject({
          code,
          message: expect.stringContaining(`${heading} ${state.configPath}:\n`),
        });
        expect(getDatabaseEngineSelection()).toBeUndefined();
        expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
        await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it.each(
    [
      ["--help"],
      ["--version"],
      ["logs"],
      ["channels", "logs"],
      ["config", "file"],
      ["config", "validate", "--json"],
      ["gateway", "status", "--runtime-intent-only", "--json"],
      ["daemon", "status", "--runtime-intent-only", "--json"],
      ["gateway", "discover"],
      ["gateway", "call", "health"],
      ["gateway", "health"],
      ["gateway", "suspend"],
      ["gateway", "resume", "synthetic-suspension"],
      ["gateway", "usage-cost"],
      ["gateway", "stability"],
      ["channels", "status"],
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
      ...recoveryOwnerCommands,
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

  it.each(recoveryOwnerCommands.map((args) => ({ args })))(
    "keeps malformed source diagnostics with the $args owner",
    async ({ args }) => {
      await withOpenClawTestState({ label: "cli-recovery-invalid-source" }, async (state) => {
        await fs.writeFile(state.configPath, '{"database":{"engine":"postgres"}, broken');
        expect(await prepareCliDatabaseEngine(["node", "openclaw", ...args])).toBe(false);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it.each(
    [
      ["agent", "--local", "--agent", "main", "--message", "hello"],
      ["nodes", "custom-plugin-command"],
      ["memory", "custom-plugin-command"],
      ["reset", "--scope", "full"],
      ["reset", "--scope=config+creds+sessions"],
      ["reset", "--scope=config", "--scope=full"],
      ["reset", "--", "--scope", "config"],
      ["uninstall", "--service", "--state"],
      ["uninstall", "--service", "--workspace"],
      ["uninstall", "--service", "--all"],
      ["uninstall", "--", "--service"],
    ].map((args) => ({ args })),
  )("still selects state for broader cleanup $args", async ({ args }) => {
    await withOpenClawTestState({ label: "cli-cleanup-engine-selection" }, async (state) => {
      await state.writeConfig({ database, plugins: { enabled: false } });
      delete process.env.OPENCLAW_TEST_CLI_DSN;
      await expect(prepareCliDatabaseEngine(["node", "openclaw", ...args])).rejects.toThrow(
        "SecretRef is unresolved",
      );
      expect(getDatabaseEngineSelection()).toBeUndefined();
      await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
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
      await withOpenClawTestState({ label: "doctor-unresolved-engine" }, async (state) => {
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
        // Handoff lock journals are temp-scoped; do not borrow another test's ledger.
        await withEnvAsync({ TMPDIR: state.root, TMP: state.root, TEMP: state.root }, () =>
          prepareCliDatabaseEngine(["node", "openclaw", "doctor", "--fix", "--non-interactive"]),
        ),
      ).toBe(true);
      expect(getDatabaseEngineSelection()).toBeUndefined();
      expect(sqliteOpen).not.toHaveBeenCalled();
      expect(postgresOpen).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
    });
  });
});
