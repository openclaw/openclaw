import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { extractSqliteTableSchema } from "../src/infra/sqlite-schema-sql.js";
import { readRemoteModelCatalog } from "../src/model-catalog/remote-store.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import {
  withCliHome,
  expectCliError,
  expectFailure,
  writeJson,
  runIsolatedCli,
  cliCase,
} from "./cli-json-stdout-contract.test-support.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

async function seedPendingStateMigration(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    // A native startup checkpoint has no history or credentials requiring Doctor custody.
    database.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "schema_meta"));
  } finally {
    database.close();
  }
}

it.each([
  cliCase("models refresh --json", {}),
  cliCase("models --json refresh", {}),
  cliCase("models refresh", { human: true }),
  cliCase("models refresh --json", { commander: true }),
  cliCase("models refresh --json", { tty: true }),
])("renders model catalog refresh failures canonically for $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const result = runIsolatedCli(tempHome, testCase.args, {
      ...testCase,
      source: [
        'import net from "node:net";',
        'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
        'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
        "globalThis.fetch.mock = {};",
      ],
    });
    const message = "Remote catalog refresh failed: Error: offline fixture";

    expectFailure(result, message, { ...testCase, cleanHuman: true, once: true, network: true });
  });
});

it.each(["--plain", "--json"])(
  "keeps human auth-list output on stdout when provider value is %s",
  async (provider) => {
    await withCliHome(async (tempHome) => {
      const result = runIsolatedCli(tempHome, ["models", "auth", "list", "--provider", provider], {
        env: { CI: "1", NO_COLOR: "1" },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Agent: main\n");
      expect(result.stdout).toContain(`Provider: ${provider}\n`);
      expect(result.stdout).toContain("Profiles: (none)\n");
      expect(result.stderr).not.toContain("Agent: main");
      expect(result.stderr).not.toContain(`Provider: ${provider}`);
    });
  },
);

it("preserves model catalog refresh success payloads and persisted rows", async () => {
  await withCliHome(async (tempHome) => {
    const stateDir = path.join(tempHome, "isolated-state");
    const configPath = path.join(tempHome, "openclaw.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const migrationDiagnostic = "state database schema migration pending";
    const generatedAt = Date.now() + 60_000;
    const bundle = {
      schemaVersion: 1,
      generatedAt,
      sourceCommit: "autoqa-model-catalog-fixture",
      providers: { openai: { models: [{ id: "gpt-5.6-luna" }] } },
    };
    const updatedBundle = { ...bundle, generatedAt: generatedAt + 1_000 };
    const preloadFor = (response: "initial" | "updated" | "unchanged" | "failure") => {
      const fixture = response === "initial" ? bundle : updatedBundle;
      const fetchResponse =
        response === "failure"
          ? 'throw new Error("offline fixture");'
          : response === "unchanged"
            ? "return new Response(null, { status: 304 });"
            : `return new Response(JSON.stringify(${JSON.stringify(fixture)}), { headers: { etag: '"fixture"' } });`;
      return Buffer.from(
        [
          'import net from "node:net";',
          'import module from "node:module";',
          'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
          "const createRequire = module.createRequire;",
          'module.createRequire = (...args) => new Proxy(createRequire(...args), { apply(target, receiver, request) { return String(request[0]).endsWith("/build-info.json") ? { builtAt: "2020-01-01T00:00:00.000Z" } : Reflect.apply(target, receiver, request); } });',
          "module.syncBuiltinESMExports();",
          `globalThis.fetch = async () => { ${fetchResponse} };`,
          "globalThis.fetch.mock = {};",
        ].join("\n"),
      ).toString("base64");
    };
    const runRefresh = (
      args: string[],
      response: "initial" | "updated" | "unchanged" | "failure",
    ) =>
      runBuiltCli(
        tempHome,
        ["models", ...args],
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
        },
        { execArgv: [`--import=data:text/javascript;base64,${preloadFor(response)}`] },
      );
    const readCatalogRow = () => readRemoteModelCatalog({ path: databasePath });

    // Reuse the first refresh process to prove migration diagnostics remain
    // on stderr instead of paying for a separate command matrix.
    await fs.writeFile(configPath, "{}\n", "utf8");
    await seedPendingStateMigration(stateDir);
    const human = runRefresh(["refresh"], "initial");
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toBe(
      `Remote catalog refresh: updated (1 providers, 1 models; generated ${new Date(bundle.generatedAt).toISOString()})\n`,
    );
    expect(human.stdout).not.toContain(migrationDiagnostic);
    expect(human.stderr).toContain(migrationDiagnostic);

    const refreshed = { generatedAt: updatedBundle.generatedAt, providers: 1, models: 1 };
    const updated = runRefresh(["refresh", "--json"], "updated");
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({ status: "updated", ...refreshed });

    const unchanged = runRefresh(["--json", "refresh"], "unchanged");
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toEqual({ status: "unchanged", ...refreshed });
    const persistedRow = readCatalogRow();
    expect(persistedRow).toMatchObject({
      generated_at: updatedBundle.generatedAt,
      bundle_json: JSON.stringify(updatedBundle),
    });

    const failure = runRefresh(["refresh", "--json"], "failure");
    expect(failure.status, failure.stderr).toBe(1);
    expectCliError(failure.stdout, "Remote catalog refresh failed: Error: offline fixture");
    expect(readCatalogRow()).toEqual(persistedRow);

    await writeJson(configPath, { models: { catalogRefresh: { enabled: false } } }, true);
    const disabled = runRefresh(["refresh", "--json"], "failure");
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(JSON.parse(disabled.stdout)).toEqual({
      status: "disabled",
      providers: 0,
      models: 0,
    });
    expect(readCatalogRow()).toEqual(persistedRow);
  });
});
