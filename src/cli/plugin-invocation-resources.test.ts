import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("../entry.ts", import.meta.url));

type ResourceEvent = { event: string; database: string; mode: string };

it("keeps native plugin resources through registration and action, then disposes at CLI completion", async () => {
  const root = tempDirs.make("openclaw-cli-registration-resources-");
  const pluginDir = path.join(root, "plugin");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const eventsPath = path.join(root, "resource-events.jsonl");
  fs.mkdirSync(pluginDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "cli-native-resource",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "descriptor.cjs"),
    `module.exports = {
  name: "native-resource",
  description: "Synthetic native resource command",
  hasSubcommands: false,
  machineOutput: ({ argv }) => argv.includes("--rows"),
};
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "cli-metadata.cjs"),
    `const descriptor = require("./descriptor.cjs");
module.exports = {
  id: "cli-native-resource",
  register(api) { api.registerCli(() => {}, { descriptors: [descriptor] }); },
};
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
let sequence = 0;
module.exports = {
  id: "cli-native-resource",
  register(api) {
    const mode = api.registrationMode;
    if (mode === "cli-metadata") throw new Error("Use the inert metadata entry");
    const databasePath = path.join(${JSON.stringify(root)}, mode + "-" + sequence++ + ".sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE observations (value TEXT NOT NULL)");
    const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ event, database: databasePath, mode }) + "\\n");
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
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      plugins: { allow: ["cli-native-resource"], load: { paths: [pluginDir] } },
    }),
  );
  const readEvents = (): ResourceEvent[] =>
    fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  const result = await runCliProcessChild({
    nodeArgs: ["--import", require.resolve("tsx"), entry, "native-resource", "--rows"],
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
        const events = readEvents();
        expect(events.some((event) => event.event === "registrar-completed")).toBe(true);
        expect(events.some((event) => event.event === "action-completed")).toBe(false);
        expect(events.filter((event) => event.event === "disposed")).toEqual([]);
      } finally {
        child.stdin.end("continue\n");
      }
    },
  });
  const diagnostics = formatCliProcessFailure({ reason: "Native plugin CLI result", ...result });
  expect(result.code, diagnostics).toBe(0);
  expect(result.signal, diagnostics).toBeNull();
  expect(JSON.parse(result.stdout), diagnostics).toEqual([
    { value: "registrar" },
    { value: "action" },
  ]);
  expect(result.stderr).toContain("native-resource diagnostic");

  const events = readEvents();
  const opened = events.filter((event) => event.event === "opened");
  expect(opened, diagnostics).toHaveLength(1);
  expect(opened[0]!.mode).not.toBe("cli-metadata");
  const completed = events.find((event) => event.event === "action-completed");
  expect(completed, diagnostics).toBeDefined();
  const reopened = new DatabaseSync(completed!.database);
  try {
    expect(reopened.prepare("SELECT value FROM observations ORDER BY rowid").all()).toEqual([
      { value: "registrar" },
      { value: "action" },
    ]);
  } finally {
    reopened.close();
  }
  expect(events.filter((event) => event.event === "cleanup")).toEqual([]);
  expect(
    events
      .filter((event) => event.event === "disposed")
      .map((event) => event.database)
      .toSorted(),
    diagnostics,
  ).toEqual(opened.map((event) => event.database).toSorted());
});
