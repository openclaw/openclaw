import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { createSqliteSchemaAssetsPlugin } from "../../scripts/lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { createWorkerDeployBuildPlugin } from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each([
  { name: "installed assets", workerChunks: false },
  { name: "sealed worker chunks", workerChunks: true },
])("loads diagnostic catalogs lazily from relocated $name", async ({ workerChunks }) => {
  const root = fs.realpathSync(createTempDir("sqlite-schema-assets-"));
  const entry = path.join(root, "entry.ts");
  fs.writeFileSync(
    entry,
    `import { readGeneratedSqliteFingerprint, readGeneratedSqliteCatalog } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/sqlite-catalogs.ts"))};
import { OPENCLAW_STATE_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/state/openclaw-state-schema.ts"))};
import { OPENCLAW_AGENT_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/state/openclaw-agent-schema.ts"))};
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/daemon/runtime-pin-schema.ts"))};
const schemas = [OPENCLAW_STATE_SCHEMA_SQL, OPENCLAW_AGENT_SCHEMA_SQL, DAEMON_RUNTIME_PIN_SCHEMA_SQL];
export const fingerprints = () => schemas.map(readGeneratedSqliteFingerprint);
export const catalogs = () => schemas.map(readGeneratedSqliteCatalog);
`,
  );
  const outDir = path.join(root, "build");
  const { bundles } = await build({
    config: false,
    entry: workerChunks ? { "worker/worker": entry } : entry,
    outDir,
    platform: "node",
    format: "esm",
    dts: false,
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: workerChunks
      ? { codeSplitting: false, chunkFileNames: "worker/worker-chunk-[hash].mjs" }
      : undefined,
    plugins: [
      createStateSchemaInlinePlugin(),
      createSqliteSchemaAssetsPlugin(undefined, undefined, { workerChunks }),
      workerChunks ? createWorkerDeployBuildPlugin() : undefined,
    ],
    logLevel: "silent",
  });
  try {
    const installed = path.join(root, "relocated");
    if (workerChunks) {
      expect(fs.readdirSync(outDir)).toEqual(["worker"]);
    }
    fs.renameSync(workerChunks ? path.join(outDir, "worker") : outDir, installed);
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import fs from 'node:fs';
const files = ${workerChunks ? "fs.readdirSync('.').filter(name => name.startsWith('worker-chunk-sqlite-'))" : "['assets']"};
if (files.length === 0) throw new Error('No diagnostic files were emitted');
for (const file of files) fs.renameSync(file, file + '.held');
const owner = await import(${JSON.stringify(workerChunks ? "./worker.mjs" : "./entry.mjs")});
const fingerprints = owner.fingerprints();
for (const file of files) fs.renameSync(file + '.held', file);
const catalogs = owner.catalogs();
console.log(JSON.stringify(fingerprints.map((fingerprint, index) => ({
  fingerprint: fingerprint.fingerprint,
  tables: catalogs[index].tables.map(table => table.name),
  expected: fingerprint.tableNames,
}))));`,
      ],
      { cwd: installed, encoding: "utf8" },
    );
    const observed = JSON.parse(result) as {
      fingerprint: string;
      tables: string[];
      expected: string[];
    }[];
    expect(observed).toHaveLength(3);
    for (const store of observed) {
      expect(store.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(store.tables).toEqual(store.expected);
      expect(store.tables.length).toBeGreaterThan(0);
    }
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
