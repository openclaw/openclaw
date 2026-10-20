import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(resetDatabaseEngineSelectionForTest);

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

const prepare = (...args: string[]) => prepareCliDatabaseEngine(["node", "openclaw", ...args]);
const withState =
  <Args extends unknown[]>(run: (state: OpenClawTestState, ...args: Args) => Promise<void>) =>
  (...args: Args) =>
    withOpenClawTestState(
      {
        label: "cli-engine-selection",
        env: {
          OPENCLAW_TEST_CLI_DSN: undefined,
          OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: undefined,
        },
      },
      (state) => run(state, ...args),
    );
async function expectUnselected(state: OpenClawTestState) {
  expect(getDatabaseEngineSelection()).toBeUndefined();
  await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function watchDatabaseOpens() {
  const sqlite = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  const postgres = vi.spyOn(databaseEngineAdapters.postgres, "openConnection");
  return () => {
    expect(getDatabaseEngineSelection()).toBeUndefined();
    expect(sqlite).not.toHaveBeenCalled();
    expect(postgres).not.toHaveBeenCalled();
  };
}

const commandVariants = (command: string, variants: string[]) =>
  variants.map((args) => [command, ...args.split(" ").filter(Boolean)]);
const recoveryOwnerCommands = [
  [],
  ["onboard", "--reset"],
  ["setup", "--wizard", "--reset"],
  ["agent", "--agent", "main", "--message", "hello"],
  ["gateway", "restart"],
  ["daemon", "stop", "--force"],
  ["node", "uninstall"],
  ["cron", "status"],
  ["nodes", "camera", "snap"],
  ["approvals", "pending"],
  ["memory", "status"],
  ...commandVariants("update", ["", "migration-plan --snapshot-state /selected/state"]),
  ...commandVariants("reset", ["--scope config", "--scope=config", "--scope=full --scope=config"]),
  ["uninstall", "--service"],
];

it.each([["models", "list"], ["onboard"], ["setup", "--wizard"], ["crestodian"]])(
  "selects the config-directed target for %j without opening a database",
  withState(async (state, ...args: string[]) => {
    process.env.OPENCLAW_TEST_CLI_DSN = "postgresql://127.0.0.1:1/test";
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
    await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }),
);

it.each([
  { source: "root" },
  {
    source: "recommendation",
    args: ["onboard", "--json", "recommendations"],
  },
  {
    source: "recommendation mutation",
    args: ["onboard", "recommendations", "refresh"],
  },
  { source: "include" },
  { source: "missing include" },
])(
  "preserves $source failure diagnostics before selecting storage",
  withState(async (state, { source, args }: { source: string; args?: string[] }) => {
    const missing = source === "missing include";
    const heading = missing ? "Config could not be read at" : "Invalid config at";
    const raw = source.includes("include") ? '{"$include":"included.json"}' : "{ invalid config";
    await fs.writeFile(state.configPath, raw);
    if (source === "include") {
      await fs.writeFile(state.statePath("included.json"), "{ invalid config");
    }

    await expect(prepare(...(args ?? ["models", "list"]))).rejects.toMatchObject({
      code: missing ? "CONFIG_READ_FAILED" : "INVALID_CONFIG",
      message: expect.stringContaining(`${heading} ${state.configPath}:\n`),
    });
    expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
    await expectUnselected(state);
  }),
);

const delegatedCommands = [
  ["--help"],
  ["--version"],
  ["logs"],
  ["channels", "logs"],
  ["config", "validate", "--json"],
  ["gateway", "status", "--runtime-intent-only", "--json"],
  ["daemon", "status", "--runtime-intent-only", "--json"],
  ["gateway", "call", "health"],
  ["gateway", "resume", "synthetic-suspension"],
  ["completion"],
  ["config", "set", "database.postgres.connection.id", "REPAIRED_DSN"],
  ["gateway", "run"],
  ["gateway", "--dev", "--reset"],
  ["doctor", "--session-sqlite", "inspect", "--session-sqlite-store", "/selected/store"],
  ["doctor", "--post-upgrade"],
  ["update", "--channel", "--", "cleanup"],
  ...recoveryOwnerCommands,
];
const cleanupCommands = [
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
];
it.each([
  ...delegatedCommands.map((args) => ({ args, mode: "delegated" })),
  ...recoveryOwnerCommands.map((args) => ({ args, mode: "malformed" })),
  ...cleanupCommands.map((args) => ({ args, mode: "cleanup" })),
])(
  "$mode storage selection for $args",
  withState(async (state, { args, mode }: { args: string[]; mode: string }) => {
    if (mode === "malformed") {
      await fs.writeFile(state.configPath, '{"database":{"engine":"postgres"}, broken');
    } else {
      await state.writeConfig({ database, plugins: { enabled: false } });
    }
    if (mode === "cleanup") {
      await expect(prepare(...args)).rejects.toThrow("SecretRef is unresolved");
    } else {
      expect(await prepare(...args)).toBe(false);
    }
    await expectUnselected(state);
  }),
);

it.each([
  { engine: "sqlite", source: "root" },
  { engine: "postgres", source: "include" },
])(
  "does not open existing storage while Doctor cannot parse $engine $source config",
  withState(async (state, { engine, source }: { engine: string; source: string }) => {
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
    const expectUnopened = watchDatabaseOpens();
    expect(await prepare("doctor", "--non-interactive", "--json")).toBe(true);
    expectUnopened();
    expect(await fs.readFile(databasePath, "utf8")).toBe("unopened synthetic store");
  }),
);

it(
  "keeps updater-owned Doctor selection with its result receipt",
  withState(async (state) => {
    process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = "-";
    await state.writeConfig({ database, plugins: { enabled: false } });
    expect(await prepare("doctor")).toBe(false);
    expect(getDatabaseEngineSelection()).toBeUndefined();
  }),
);

it(
  "keeps storage unopened when prefix repair leaves a PostgreSQL credential unresolved",
  withState(async (state) => {
    const config = { database, plugins: { enabled: false } };
    await fs.writeFile(state.configPath, `synthetic warning\n${JSON.stringify(config)}\n`);
    const expectUnopened = watchDatabaseOpens();
    expect(
      // Handoff lock journals are temp-scoped; do not borrow another test's ledger.
      await withEnvAsync({ TMPDIR: state.root, TMP: state.root, TEMP: state.root }, () =>
        prepare("doctor", "--fix", "--non-interactive"),
      ),
    ).toBe(true);
    expectUnopened();
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
  }),
);
