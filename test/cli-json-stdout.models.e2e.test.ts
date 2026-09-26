import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readRemoteModelCatalog } from "../src/model-catalog/remote-store.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

async function seedPendingStateMigration(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec("DROP INDEX idx_worker_session_placements_environment; PRAGMA user_version = 0;");
  } finally {
    database.close();
  }
}

describe("cli json stdout contract", () => {
  it.each([
    { name: "leaf JSON", args: ["models", "refresh", "--json"] },
    { name: "parent JSON", args: ["models", "--json", "refresh"] },
    { name: "human output", args: ["models", "refresh"], human: true },
    {
      name: "forced Commander JSON",
      args: ["models", "refresh", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY JSON",
      args: ["models", "refresh", "--json"],
      tty: true,
    },
  ])("renders model catalog refresh failures canonically for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
            "globalThis.fetch.mock = {};",
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
          },
          { execArgv: [`--import=data:text/javascript;base64,${preload}`] },
        );
        const message = "Remote catalog refresh failed: Error: offline fixture";

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toContain("\u001B");
        expect(result.stdout, result.stderr).not.toContain("\u0007");
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        expect(result.stderr.split(message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-models-refresh-json-failure-e2e-" },
    );
  });

  it.each(["--plain", "--json"])(
    "keeps human auth-list output on stdout when provider value is %s",
    async (provider) => {
      await withTempHome(
        async (tempHome) => {
          const result = runBuiltCli(tempHome, ["models", "auth", "list", "--provider", provider], {
            CI: "1",
            NO_COLOR: "1",
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Agent: main\n");
          expect(result.stdout).toContain(`Provider: ${provider}\n`);
          expect(result.stdout).toContain("Profiles: (none)\n");
          expect(result.stderr).not.toContain("Agent: main");
          expect(result.stderr).not.toContain(`Provider: ${provider}`);
        },
        { prefix: "openclaw-models-output-option-value-e2e-" },
      );
    },
  );

  it("preserves model catalog refresh success payloads and persisted rows", async () => {
    await withTempHome(
      async (tempHome) => {
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
        expect(human.stdout).toContain("Remote catalog refresh: updated (1 providers, 1 models;");
        expect(human.stdout).not.toContain(migrationDiagnostic);
        expect(human.stderr).toContain(migrationDiagnostic);
        expect(human.stdout).toContain(
          "A running Gateway applies the updated catalog after its next restart.",
        );

        const updated = runRefresh(["refresh", "--json"], "updated");
        expect(updated.status, updated.stderr).toBe(0);
        expect(JSON.parse(updated.stdout)).toEqual({
          status: "updated",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });

        const unchanged = runRefresh(["--json", "refresh"], "unchanged");
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(JSON.parse(unchanged.stdout)).toEqual({
          status: "unchanged",
          generatedAt: updatedBundle.generatedAt,
          providers: 1,
          models: 1,
        });
        const persistedRow = readCatalogRow();
        expect(persistedRow).toMatchObject({
          generated_at: updatedBundle.generatedAt,
          bundle_json: JSON.stringify(updatedBundle),
        });

        const failure = runRefresh(["refresh", "--json"], "failure");
        expect(failure.status, failure.stderr).toBe(1);
        expect(JSON.parse(failure.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Remote catalog refresh failed: Error: offline fixture",
          },
        });
        expect(readCatalogRow()).toEqual(persistedRow);

        await fs.writeFile(
          configPath,
          `${JSON.stringify({ models: { catalogRefresh: { enabled: false } } })}\n`,
          "utf8",
        );
        const disabled = runRefresh(["refresh", "--json"], "failure");
        expect(disabled.status, disabled.stderr).toBe(0);
        expect(JSON.parse(disabled.stdout)).toEqual({
          status: "disabled",
          providers: 0,
          models: 0,
        });
        expect(readCatalogRow()).toEqual(persistedRow);
      },
      { prefix: "openclaw-models-refresh-persistence-e2e-" },
    );
  });
});
