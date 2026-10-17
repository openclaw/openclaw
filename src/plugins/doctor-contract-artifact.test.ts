import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolve as resolvePackageImport } from "import-meta-resolve";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writePackage(root: string, openclaw: unknown, name?: string): void {
  const metadata = { type: "module", ...(name ? { name } : {}), openclaw };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(metadata));
}

function digest(bytes: string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runChild(script: string): void {
  const result = spawnNodeEvalSync(script, { timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function contract(marker: string, extension: string): string {
  const rules = JSON.stringify([{ path: ["doctor-fixture"], message: marker }]);
  const migrations = `[{ id: "fixture-state", label: "Fixture state", detectLegacyState() { return { preview: [${JSON.stringify(marker)}] }; }, migrateLegacyState() { return { changes: [${JSON.stringify(marker)}], warnings: [] }; } }]`;
  return extension === ".cjs"
    ? `module.exports = { legacyConfigRules: ${rules}, stateMigrations: ${migrations} };\n`
    : `export const legacyConfigRules = ${rules}; export const stateMigrations = ${migrations};\n`;
}

it("keeps Doctor artifact hash and loading consistent across source and built hosts", async () => {
  const root = fs.realpathSync(tempDirs.make("openclaw-doctor-artifacts-"));
  const bundled = await build({
    stdin: {
      contents: [
        'export { loadInstalledPluginIndex } from "./src/plugins/installed-plugin-index.ts";',
        'export { readPersistedInstalledPluginIndexSync } from "./src/plugins/installed-plugin-index-store.ts";',
        'export { loadPluginRegistrySnapshotWithMetadata } from "./src/plugins/plugin-registry-snapshot.ts";',
        'export { loadPluginMetadataSnapshot } from "./src/plugins/plugin-metadata-snapshot.ts";',
        'export { withPluginMetadataSnapshotScope } from "./src/plugins/current-plugin-metadata-snapshot.ts";',
        'export { listPluginDoctorLegacyConfigRules, listPluginDoctorStateMigrationEntries } from "./src/plugins/doctor-contract-registry.ts";',
        'export { adoptProcessPluginCache, createPluginCache, resetPluginCache, withPluginCache } from "./src/plugins/plugin-cache.ts";',
      ].join("\n"),
      resolveDir: process.cwd(),
    },
    bundle: true,
    packages: "external",
    plugins: [
      {
        name: "fixture-external-import-context",
        setup(builder) {
          const resolving = {};
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData === resolving || isBuiltin(args.path)) {
              return undefined;
            }
            const { path: specifier, ...options } = args;
            const resolved = await builder.resolve(specifier, {
              ...options,
              pluginData: resolving,
            });
            const result = { ...resolved, pluginData: undefined };
            if (!result.external || result.errors.length > 0) {
              return result;
            }
            const parent = pathToFileURL(args.importer);
            result.path =
              args.kind === "require-call" || args.kind === "require-resolve"
                ? createRequire(parent).resolve(args.path)
                : resolvePackageImport(args.path, parent.href);
            return result;
          });
        },
      },
    ],
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const output = bundled.outputFiles[0];
  assert(output, "missing compiled Doctor fixture owner");
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  for (const mode of ["source", "dist"]) {
    fs.mkdirSync(path.join(root, mode));
    fs.writeFileSync(path.join(root, mode, "owner.mjs"), output.contents);
    for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      fs.copyFileSync(path.resolve("src/state", schema), path.join(root, mode, schema));
    }
  }
  // The same compiled bytes run from real source/dist locations. No host-mode override.
  const source = "extensions/demo/doctor-contract-api.ts";
  const built = "dist/extensions/demo/doctor-contract-api.js";
  const staged = "dist-runtime/extensions/demo/doctor-contract-api.js";
  const local = "extensions/demo/dist/doctor-contract-api.js";
  const staging = { expected: built, staging: true };
  const linkedCanonical = { ...staging, canonicalDirectorySymlink: true };
  const missingCanonical = { expected: staged, staging: true, noCanonical: true };
  const rows = [
    { name: "source host", expected: source, mode: "source" },
    { name: "built ESM", expected: built, extension: ".js" },
    { name: "built MJS", expected: built.replace(".js", ".mjs"), extension: ".mjs" },
    { name: "built CJS", expected: built.replace(".js", ".cjs"), extension: ".cjs" },
    { name: "canonical replaces staging", ...staging },
    { name: "staging link to canonical", ...staging, stagingSymlink: true },
    { name: "canonical directory link", ...linkedCanonical },
    {
      name: "linked staging file and canonical directory",
      ...linkedCanonical,
      stagingSymlink: true,
    },
    { name: "staging without canonical", ...missingCanonical },
    { name: "partial canonical build", ...missingCanonical, partialCanonical: true },
    { name: "configured source", expected: source, sourcePreferred: true },
    { name: "local MTS order", expected: local, sourceExtension: ".mts", local: true },
    { name: "source external", expected: built, bundledDist: false, local: true },
    { name: "no root anchor", expected: local, bundledDist: false, local: true, noAnchor: true },
    { name: "external install", expected: `state/${source}`, origin: "global" },
    { name: "missing emitted metadata", expected: source, noMetadata: true },
    { name: "ambiguous emitted format", expected: source, ambiguous: true },
  ];
  const fixtures = rows.map((row, ordinal) => {
    const fixtureRoot = path.join(root, `fixture-${ordinal}`);
    const relativePluginRoot =
      row.origin === "global" ? "state/extensions/demo" : "extensions/demo";
    const pluginRoot = path.join(fixtureRoot, relativePluginRoot);
    const builtRoot = path.join(fixtureRoot, "dist", "extensions", "demo");
    const stagingRoot = path.join(fixtureRoot, "dist-runtime", "extensions", "demo");
    const sourceExtension = row.sourceExtension ?? ".ts";
    const extension = row.extension ?? ".js";
    const packageManifest = { extensions: ["./index.ts"], build: { bundledDist: row.bundledDist } };
    const canonicalDirs =
      row.noCanonical && !row.partialCanonical ? [] : [path.join(builtRoot, "dist")];
    for (const dir of [stagingRoot, path.join(pluginRoot, "dist"), ...canonicalDirs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writePackage(pluginRoot, packageManifest, "doctor-fixture");
    fs.writeFileSync(
      path.join(pluginRoot, "index.ts"),
      'throw new Error("runtime must remain unloaded");\n',
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        configSchema: { type: "object" },
        doctorContract: { configRepair: true, stateMigrations: [{ id: "fixture-state" }] },
      }),
    );
    const contents = new Map<string, { bytes: string; marker: string }>();
    const addContract = (dir: string, marker: string, ext = extension) => {
      contents.set(`${dir}/doctor-contract-api${ext}`, { bytes: contract(marker, ext), marker });
    };
    if (!row.noAnchor) {
      addContract(relativePluginRoot, "source", sourceExtension);
    }
    if (!row.noCanonical) {
      addContract("dist/extensions/demo", "built");
    }
    if (row.staging) {
      if (!row.stagingSymlink) {
        addContract("dist-runtime/extensions/demo", "staging");
      }
      writePackage(stagingRoot, { extensions: [`./index${extension}`] });
    }
    // A broader contract must never replace the selected Doctor basename.
    contents.set(`${relativePluginRoot}/contract-api.js`, {
      bytes: contract("broad", ".js"),
      marker: "broad",
    });
    if (row.local) {
      for (const localExtension of [".js", ".mjs", ".cjs"]) {
        addContract(`${relativePluginRoot}/dist`, `local${localExtension}`, localExtension);
      }
      addContract("dist/extensions/demo/dist", "nested", ".js");
    }
    for (const [relative, { bytes }] of contents) {
      fs.writeFileSync(path.join(fixtureRoot, relative), bytes);
    }
    if (row.stagingSymlink) {
      fs.symlinkSync(
        path.join(builtRoot, `doctor-contract-api${extension}`),
        path.join(stagingRoot, `doctor-contract-api${extension}`),
      );
    }
    if (!row.noMetadata && !row.noCanonical) {
      writePackage(builtRoot, {
        extensions: row.ambiguous ? ["./index.js", "./other.cjs"] : [`./index${extension}`],
      });
    }
    if (row.canonicalDirectorySymlink) {
      const outputRoot = path.join(fixtureRoot, "outputs");
      fs.renameSync(builtRoot, outputRoot);
      fs.symlinkSync(outputRoot, builtRoot, "junction");
    }
    const expected = contents.get(row.expected);
    assert(expected, `missing literal expected artifact for ${row.name}`);
    return Object.assign(row, {
      root: fixtureRoot,
      pluginRoot,
      packageManifest,
      expectedHash: digest(expected.bytes),
      sourceHash: digest(contract("source", sourceExtension)),
      replacementBytes: contract("replacement", extension),
      expectedMarker: expected.marker,
    });
  });
  const selectedIndexPath = path.join(root, "built-selected-index.json");
  runChild(
    `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      const owners = {
        source: await import(${JSON.stringify(pathToFileURL(path.join(root, "source", "owner.mjs")).href)}),
        dist: await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "owner.mjs")).href)}),
      };
      for (const row of ${JSON.stringify(fixtures)}) {
        const owner = owners[row.mode ?? "dist"];
        const cache = owner.createPluginCache();
        owner.adoptProcessPluginCache(cache);
        owner.withPluginCache(cache, () => {
          const env = { HOME: row.root, OPENCLAW_STATE_DIR: path.join(row.root, "state"), OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(row.root, "extensions"), OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1", OPENCLAW_VERSION: "2026.9.2", VITEST: "true" };
          const config = { plugins: { entries: { demo: { enabled: true } }, ...(row.sourcePreferred ? { load: { paths: [row.pluginRoot] } } : {}) } };
          const candidate = { idHint: "demo", rootDir: row.pluginRoot, source: path.join(row.pluginRoot, "index.ts"), packageDir: row.pluginRoot, origin: row.origin ?? "bundled", packageManifest: row.packageManifest, ...(row.sourcePreferred ? { sourcePreferred: true } : {}) };
          const index = owner.loadInstalledPluginIndex({ candidates: [candidate], config, env });
          assert.equal(index.plugins[0]?.doctorContractHash, row.expectedHash, row.name);
          const snapshot = owner.loadPluginMetadataSnapshot({ index, config, env });
          const rules = owner.withPluginMetadataSnapshotScope(snapshot, () => owner.listPluginDoctorLegacyConfigRules({ config, env, pluginIds: ["demo"] }), { config, env });
          assert.deepEqual(rules, [{ path: ["doctor-fixture"], message: row.expectedMarker }], row.name);
          const entries = owner.withPluginMetadataSnapshotScope(snapshot, () => owner.listPluginDoctorStateMigrationEntries({ config, env, pluginIds: ["demo"] }), { config, env });
          assert.equal(entries.length, 1, row.name);
          assert.equal(entries[0].migration.id, "fixture-state", row.name);
          const input = { config, env, stateDir: env.OPENCLAW_STATE_DIR, oauthDir: path.join(row.root, "oauth"), context: {} };
          assert.deepEqual(entries[0].migration.detectLegacyState(input), { preview: [row.expectedMarker] }, row.name);
          assert.deepEqual(entries[0].migration.migrateLegacyState(input), { changes: [row.expectedMarker], warnings: [] }, row.name);
          if (row.name === "built ESM") {
            const sourceConfig = { plugins: { ...config.plugins, load: { paths: [row.pluginRoot] } } };
            const sourceIndex = owner.loadInstalledPluginIndex({ candidates: [{ ...candidate, sourcePreferred: true }], config: sourceConfig, env });
            assert.equal(sourceIndex.plugins[0]?.doctorContractHash, row.sourceHash);
            const repeated = owner.loadInstalledPluginIndex({ candidates: [candidate], config, env });
            assert.equal(repeated.plugins[0]?.doctorContractHash, row.expectedHash);
            fs.writeFileSync(${JSON.stringify(selectedIndexPath)}, JSON.stringify(index));
            fs.writeFileSync(path.join(row.root, row.expected), row.replacementBytes);
            assert.equal(snapshot.index.plugins[0].doctorContractHash, row.expectedHash);
          }
        });
        owner.resetPluginCache();
      }
    `,
  );
  const replacementFixture = fixtures.find((row) => row.name === "built ESM");
  assert(replacementFixture, "missing built ESM replacement fixture");
  const selectedIndex = parseInstalledPluginIndex(
    JSON.parse(fs.readFileSync(selectedIndexPath, "utf8")),
  );
  assert(selectedIndex, "invalid built-selected index fixture");
  expect(selectedIndex.plugins[0]?.doctorContractHash).toBe(replacementFixture.expectedHash);
  const env = {
    HOME: replacementFixture.root,
    OPENCLAW_STATE_DIR: path.join(replacementFixture.root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(replacementFixture.root, "extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_VERSION: "2026.9.2",
    VITEST: "true",
  };
  try {
    await writePersistedInstalledPluginIndex(selectedIndex, { env });
  } finally {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
  }
  // Compiled ESM changes take effect after restart, not by evicting require.cache.
  runChild(
    `
      import assert from "node:assert/strict";
      import crypto from "node:crypto";
      import path from "node:path";
      const owner = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "owner.mjs")).href)});
      const row = ${JSON.stringify(replacementFixture)};
      const env = { HOME: row.root, OPENCLAW_STATE_DIR: path.join(row.root, "state"), OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(row.root, "extensions"), OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1", OPENCLAW_VERSION: "2026.9.2", VITEST: "true" };
      const config = { plugins: { entries: { demo: { enabled: true } } } };
      const previous = owner.readPersistedInstalledPluginIndexSync({ env });
      assert.equal(previous.plugins[0].doctorContractHash, row.expectedHash);
      const refreshed = owner.loadPluginRegistrySnapshotWithMetadata({ config, env, allowCurrent: false });
      assert.equal(refreshed.source, "derived");
      const plugin = refreshed.snapshot.plugins.find((entry) => entry.pluginId === "demo");
      assert.equal(plugin.doctorContractHash, crypto.createHash("sha256").update(row.replacementBytes).digest("hex"));
      assert.equal(plugin.manifestHash, previous.plugins[0].manifestHash);
      assert.equal(plugin.packageJson.hash, previous.plugins[0].packageJson.hash);
      const next = owner.loadPluginMetadataSnapshot({ index: refreshed.snapshot, config, env });
      const rules = owner.withPluginMetadataSnapshotScope(next, () => owner.listPluginDoctorLegacyConfigRules({ config, env, pluginIds: ["demo"] }), { config, env });
      assert.deepEqual(rules, [{ path: ["doctor-fixture"], message: "replacement" }]);
      const entries = owner.withPluginMetadataSnapshotScope(next, () => owner.listPluginDoctorStateMigrationEntries({ config, env, pluginIds: ["demo"] }), { config, env });
      const input = { config, env, stateDir: env.OPENCLAW_STATE_DIR, oauthDir: path.join(row.root, "oauth"), context: {} };
      assert.deepEqual(entries[0].migration.detectLegacyState(input), { preview: ["replacement"] });
      assert.deepEqual(entries[0].migration.migrateLegacyState(input), { changes: ["replacement"], warnings: [] });
    `,
  );
}, 60_000);
