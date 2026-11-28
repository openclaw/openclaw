import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { createDatabaseSchemaAssetsPlugin } from "../../scripts/lib/database-schema-assets.mts";
import { createManagedHandoffBuildConfigs } from "../../scripts/lib/managed-handoff-build-config.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { createWorkerDeployBuildPlugin } from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { agentPostgresRuntime } from "../../src/state/postgres-schema.generated/agent-runtime.js";
import { agentSearchPostgresRuntime } from "../../src/state/postgres-schema.generated/agent-search-runtime.js";
import { statePostgresRuntime } from "../../src/state/postgres-schema.generated/runtime.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each([
  { name: "installed assets", workerChunks: false },
  { name: "sealed worker chunks", workerChunks: true },
])("retains lazy schema payloads from relocated $name", async ({ workerChunks }) => {
  const root = fs.realpathSync(createTempDir("sqlite-schema-assets-"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  const entry = path.join(root, "entry.ts");
  fs.writeFileSync(
    entry,
    `import { readGeneratedSqliteFingerprint, readGeneratedSqliteCatalog } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/sqlite-catalogs.ts"))};
import { OPENCLAW_STATE_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/state/openclaw-state-schema.ts"))};
import { OPENCLAW_AGENT_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/state/openclaw-agent-schema.ts"))};
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from ${JSON.stringify(path.resolve("src/daemon/runtime-pin-schema.ts"))};
import { statePostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/runtime.ts"))};
import { agentPostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/agent-runtime.ts"))};
import { agentSearchPostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/agent-search-runtime.ts"))};
export const postgres = () => [statePostgresRuntime, agentPostgresRuntime, agentSearchPostgresRuntime];
const schemas = [OPENCLAW_STATE_SCHEMA_SQL, OPENCLAW_AGENT_SCHEMA_SQL, DAEMON_RUNTIME_PIN_SCHEMA_SQL];
export const fingerprints = () => schemas.map(readGeneratedSqliteFingerprint);
export const catalogs = () => schemas.map(readGeneratedSqliteCatalog);
export { retainUpdateRuntimeImports } from ${JSON.stringify(path.resolve("src/infra/update-retained-runtime-imports.ts"))};
`,
  );
  const outDir = path.join(root, "build");
  const recordedInputs = new Set<string>();
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
      createDatabaseSchemaAssetsPlugin(undefined, (file) => recordedInputs.add(file), {
        workerChunks,
      }),
      workerChunks ? createWorkerDeployBuildPlugin() : undefined,
    ],
    logLevel: "silent",
  });
  try {
    const payloadInputs = [...recordedInputs].filter((file) =>
      path.basename(file).startsWith("postgres-"),
    );
    expect(payloadInputs).toHaveLength(12);
    for (const file of payloadInputs) {
      const basename = path.basename(file).replace(/\.ts$/u, ".mjs");
      const emitted = workerChunks
        ? `worker/worker-chunk-${basename}`
        : `assets/postgres-schema/${basename}`;
      expect(fs.readFileSync(path.join(outDir, emitted), "utf8")).toBe(
        fs.readFileSync(file, "utf8"),
      );
    }
    const installed = path.join(root, "relocated");
    if (workerChunks) {
      expect(fs.readdirSync(outDir)).toEqual(["worker"]);
    }
    fs.renameSync(workerChunks ? path.join(outDir, "worker") : outDir, installed);
    // SQLite must load the schema owners without reading PostgreSQL-only DDL.
    const installedEntry = workerChunks ? "worker.mjs" : "entry.mjs";
    expect(
      fs
        .readFileSync(path.join(installed, installedEntry), "utf8")
        .includes("Generated runtime DDL; the owner supplies search_path and the transaction."),
    ).toBe(false);
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const files = ${workerChunks ? "fs.readdirSync('.').filter(name => /^worker-chunk-(sqlite-|postgres-)/.test(name))" : "['assets']"};
if (files.length === 0) throw new Error('No diagnostic files were emitted');
for (const file of files) fs.renameSync(file, file + '.held');
const owner = await import(${JSON.stringify(workerChunks ? "./worker.mjs" : "./entry.mjs")});
const fingerprints = owner.fingerprints();
for (const file of files) fs.renameSync(file + '.held', file);
const root = process.cwd();
const retained = root + '.retained';
const inventory = fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name))
  .map(file => ({ sourcePath: file, identityPath: file }));
fs.cpSync(root, retained, { recursive: true });
owner.retainUpdateRuntimeImports([{ sourceRoot: root, destinationRoot: retained }], inventory);
const replacement = JSON.stringify({ tables: [], catalogs: {} });
for (const file of files) {
  if (fs.statSync(file).isDirectory()) {
    for (const entry of fs.readdirSync(file, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) fs.writeFileSync(path.join(entry.parentPath, entry.name), replacement);
    }
  } else {
    fs.writeFileSync(file, 'export default ' + JSON.stringify(replacement) + ';');
  }
}
const catalogs = owner.catalogs();
console.log(JSON.stringify({ postgres: createHash('sha256').update(JSON.stringify(owner.postgres())).digest('hex'), catalogs: fingerprints.map((fingerprint, index) => ({
  fingerprint: fingerprint.fingerprint,
  tables: catalogs[index].tables.map(table => table.name),
  expected: fingerprint.tableNames,
})) }));`,
      ],
      { cwd: installed, encoding: "utf8" },
    );
    const observed = JSON.parse(result) as {
      postgres: string;
      catalogs: {
        fingerprint: string;
        tables: string[];
        expected: string[];
      }[];
    };
    expect(observed.postgres).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([statePostgresRuntime, agentPostgresRuntime, agentSearchPostgresRuntime]),
        )
        .digest("hex"),
    );
    expect(observed.catalogs).toHaveLength(3);
    for (const store of observed.catalogs) {
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

it("materializes all PostgreSQL payloads from a relocated self-contained recovery runtime", async () => {
  const root = fs.realpathSync(createTempDir("postgres-recovery-payloads-"));
  const entry = path.join(root, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `import { statePostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/runtime.ts"))};`,
      `import { agentPostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/agent-runtime.ts"))};`,
      `import { agentSearchPostgresRuntime } from ${JSON.stringify(path.resolve("src/state/postgres-schema.generated/agent-search-runtime.ts"))};`,
      "export const values = () => [statePostgresRuntime, agentPostgresRuntime, agentSearchPostgresRuntime];",
    ].join("\n"),
  );
  const outDir = path.join(root, "build");
  const { bundles } = await build({
    ...createManagedHandoffBuildConfigs()[0],
    config: false,
    entry: { runtime: entry },
    outDir,
    logLevel: "silent",
  });
  try {
    const installed = path.join(root, "relocated.mjs");
    fs.renameSync(path.join(outDir, "runtime.mjs"), installed);
    fs.rmSync(outDir, { recursive: true });
    fs.rmSync(entry);
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { isBuiltin, registerHooks } from 'node:module';
      const entry = ${JSON.stringify(pathToFileURL(installed).href)};
      registerHooks({ resolve(specifier, context, next) {
        if (!isBuiltin(specifier) && specifier !== entry) throw new Error('External recovery dependency: ' + specifier);
        return next(specifier, context);
      } });
      console.log(JSON.stringify((await import(entry)).values()));
    `,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual(
      structuredClone([statePostgresRuntime, agentPostgresRuntime, agentSearchPostgresRuntime]),
    );
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
