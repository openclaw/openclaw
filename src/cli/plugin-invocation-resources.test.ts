import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { writeFixtureJsonSync } from "./cli-fixtures.test-support.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const expectedRows = [{ value: "registrar" }, { value: "action" }];
const activePhases = ["opened", "registrar-entered", "registrar-completed", "action-entered"];

it("keeps native plugin resources through registration and action, then disposes at CLI completion", async () => {
  const root = tempDirs.make("openclaw-cli-registration-resources-");
  const pluginDir = path.join(root, "plugin");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const eventsPath = path.join(root, "resource-events.log");
  const databasePath = path.join(root, "runtime.sqlite");
  fs.mkdirSync(pluginDir);
  fs.mkdirSync(stateDir);
  const files = {
    "openclaw.plugin.json": JSON.stringify({
      id: "cli-native-resource",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "descriptor.cjs": `module.exports = {
  name: "native-resource",
  description: "Synthetic native resource command",
  hasSubcommands: false,
  machineOutput: ({ argv }) => argv.includes("--rows"),
};
`,
    "cli-metadata.cjs": `const descriptor = require("./descriptor.cjs");
module.exports = {
  id: "cli-native-resource",
  register(api) { api.registerCli(() => {}, { descriptors: [descriptor] }); },
};
`,
    "index.cjs": `const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: "cli-native-resource",
  register(api) {
    if (api.registrationMode === "cli-metadata") throw new Error("Use the inert metadata entry");
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec("CREATE TABLE observations (value TEXT NOT NULL)");
    const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
    record("opened");
    api.registerRuntimeLifecycle({
      id: "native-cli-resource",
      dispose() {
        database.close();
        record("disposed");
      },
      cleanup() { record("cleanup"); },
    });
    api.registerCli(async ({ program }) => {
      record("registrar-entered");
      await Promise.resolve();
      database.prepare("INSERT INTO observations VALUES (?)").run("registrar");
      program.command("native-resource").option("--rows").action(async () => {
        const resume = new Promise((resolve) => process.stdin.once("data", resolve));
        process.stdin.resume();
        record("action-entered");
        process.stderr.write("native-resource action entered\\n");
        await resume;
        database.prepare("INSERT INTO observations VALUES (?)").run("action");
        const rows = database.prepare("SELECT value FROM observations ORDER BY rowid").all();
        record("action-completed");
        console.log("native-resource diagnostic");
        process.stdout.write(JSON.stringify(rows) + "\\n");
      });
      record("registrar-completed");
    }, {
      descriptors: [require("./descriptor.cjs")],
    });
  },
};
`,
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(pluginDir, name), contents);
  }
  writeFixtureJsonSync(configPath, {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { allow: ["cli-native-resource"], load: { paths: [pluginDir] } },
  });
  const readEvents = () => fs.readFileSync(eventsPath, "utf8").trim().split("\n");

  const result = await runCliProcessChild({
    nodeArgs: [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
      "native-resource",
      "--rows",
    ],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMPDIR: process.env.TMPDIR,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
      NO_COLOR: "1",
    },
    async interact(child) {
      try {
        await waitForCliProcessStderrMarker(child, "native-resource action entered");
        expect(readEvents()).toEqual(activePhases);
      } finally {
        child.stdin.end("continue\n");
      }
    },
  });
  const diagnostics = formatCliProcessFailure({ reason: "Native plugin CLI result", ...result });
  expect(result, diagnostics).toMatchObject({ code: 0, signal: null });
  expect(JSON.parse(result.stdout), diagnostics).toEqual(expectedRows);
  expect(result.stderr).toContain("native-resource diagnostic");
  expect(fs.readdirSync(path.join(stateDir, "tmp", "plugin-captures"))).toEqual([]);

  expect(readEvents(), diagnostics).toEqual([...activePhases, "action-completed", "disposed"]);
  using reopened = new DatabaseSync(databasePath);
  expect(reopened.prepare("SELECT value FROM observations ORDER BY rowid").all()).toEqual(
    expectedRows,
  );
});
