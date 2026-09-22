import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function contract(marker: string, extension: string): string {
  const rules = JSON.stringify([{ path: ["doctor-fixture"], message: marker }]);
  const migrations = `[{ id: "fixture-state", label: "Fixture state", detectLegacyState() { return { preview: [${JSON.stringify(marker)}] }; }, migrateLegacyState() { return { changes: [${JSON.stringify(marker)}], warnings: [] }; } }]`;
  return extension === ".cjs" || extension === ".cts"
    ? `module.exports = { legacyConfigRules: ${rules}, stateMigrations: ${migrations} };\n`
    : `export const legacyConfigRules = ${rules}; export const stateMigrations = ${migrations};\n`;
}

describe("Doctor artifact hash and loading agreement", () => {
  it("keeps the selected bytes consistent across source and built hosts", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-artifacts-"));
    const bundled = await build({
      stdin: {
        contents: [
          'export { loadInstalledPluginIndex } from "./src/plugins/installed-plugin-index.ts";',
          'export { writePersistedInstalledPluginIndexSync } from "./src/plugins/installed-plugin-index-store-write.ts";',
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
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const output = bundled.outputFiles[0];
    if (!output) {
      throw new Error("missing compiled Doctor fixture owner");
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    for (const mode of ["source", "dist"]) {
      fs.mkdirSync(path.join(root, mode));
      fs.writeFileSync(path.join(root, mode, "owner.mjs"), output.contents);
      for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
        fs.copyFileSync(path.resolve("src/state", schema), path.join(root, mode, schema));
      }
    }
    // The same compiled bytes run from real source/dist locations. No host-mode override.
    const rows = [
      { name: "source host", mode: "source", expected: "extensions/demo/doctor-contract-api.ts" },
      {
        name: "built ESM",
        extension: ".js",
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "built MJS",
        extension: ".mjs",
        expected: "dist/extensions/demo/doctor-contract-api.mjs",
      },
      {
        name: "built CJS",
        extension: ".cjs",
        expected: "dist/extensions/demo/doctor-contract-api.cjs",
      },
      {
        name: "canonical replaces staging",
        staging: true,
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "staging link to canonical",
        staging: true,
        stagingSymlink: true,
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "canonical directory link",
        staging: true,
        canonicalDirectorySymlink: true,
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "staging file and canonical directory links",
        staging: true,
        stagingSymlink: true,
        canonicalDirectorySymlink: true,
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "staging without canonical",
        staging: true,
        noCanonical: true,
        expected: "dist-runtime/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "partial canonical build",
        staging: true,
        noCanonical: true,
        partialCanonical: true,
        expected: "dist-runtime/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "configured source",
        sourcePreferred: true,
        expected: "extensions/demo/doctor-contract-api.ts",
      },
      {
        name: "local MTS order",
        sourceExtension: ".mts",
        local: true,
        expected: "extensions/demo/dist/doctor-contract-api.js",
      },
      {
        name: "local CTS order",
        sourceExtension: ".cts",
        local: true,
        expected: "extensions/demo/dist/doctor-contract-api.js",
      },
      {
        name: "source external",
        bundledDist: false,
        local: true,
        expected: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        name: "no root anchor",
        bundledDist: false,
        local: true,
        noAnchor: true,
        expected: "extensions/demo/dist/doctor-contract-api.js",
      },
      {
        name: "external install",
        origin: "global",
        expected: "state/extensions/demo/doctor-contract-api.ts",
      },
      {
        name: "missing emitted metadata",
        noMetadata: true,
        expected: "extensions/demo/doctor-contract-api.ts",
      },
      {
        name: "ambiguous emitted format",
        ambiguous: true,
        expected: "extensions/demo/doctor-contract-api.ts",
      },
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
      const packageManifest = {
        extensions: ["./index.ts"],
        build: { bundledDist: row.bundledDist },
      };
      for (const dir of [
        pluginRoot,
        stagingRoot,
        path.join(pluginRoot, "dist"),
        ...(row.noCanonical && !row.partialCanonical
          ? []
          : [builtRoot, path.join(builtRoot, "dist")]),
      ]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({ name: "doctor-fixture", type: "module", openclaw: packageManifest }),
      );
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
      const contents = new Map<string, string>();
      if (!row.noAnchor) {
        contents.set(
          `${relativePluginRoot}/doctor-contract-api${sourceExtension}`,
          contract("source", sourceExtension),
        );
      }
      if (!row.noCanonical) {
        contents.set(
          `dist/extensions/demo/doctor-contract-api${extension}`,
          contract("built", extension),
        );
      }
      if (row.staging) {
        if (!row.stagingSymlink) {
          contents.set(
            `dist-runtime/extensions/demo/doctor-contract-api${extension}`,
            contract("staging", extension),
          );
        }
        fs.writeFileSync(
          path.join(stagingRoot, "package.json"),
          JSON.stringify({ type: "module", openclaw: { extensions: [`./index${extension}`] } }),
        );
      }
      // A broader contract must never replace the selected Doctor basename.
      contents.set(`${relativePluginRoot}/contract-api.js`, contract("broad", ".js"));
      if (row.local) {
        for (const localExtension of [".js", ".mjs", ".cjs"]) {
          contents.set(
            `${relativePluginRoot}/dist/doctor-contract-api${localExtension}`,
            contract(`local${localExtension}`, localExtension),
          );
        }
        contents.set("dist/extensions/demo/dist/doctor-contract-api.js", contract("nested", ".js"));
      }
      for (const [relative, bytes] of contents) {
        fs.writeFileSync(path.join(fixtureRoot, relative), bytes);
      }
      if (row.stagingSymlink) {
        fs.symlinkSync(
          path.join(builtRoot, `doctor-contract-api${extension}`),
          path.join(stagingRoot, `doctor-contract-api${extension}`),
        );
      }
      if (!row.noMetadata && !row.noCanonical) {
        fs.writeFileSync(
          path.join(builtRoot, "package.json"),
          JSON.stringify({
            type: "module",
            openclaw: {
              extensions: row.ambiguous ? ["./index.js", "./other.cjs"] : [`./index${extension}`],
            },
          }),
        );
      }
      if (row.canonicalDirectorySymlink) {
        const outputRoot = path.join(fixtureRoot, "outputs");
        fs.renameSync(builtRoot, outputRoot);
        fs.symlinkSync(outputRoot, builtRoot, "junction");
      }
      const expectedBytes = contents.get(row.expected);
      if (!expectedBytes) {
        throw new Error(`missing literal expected artifact for ${row.name}`);
      }
      return Object.assign(row, {
        root: fixtureRoot,
        pluginRoot,
        packageManifest,
        expectedHash: crypto.createHash("sha256").update(expectedBytes).digest("hex"),
        sourceHash: crypto
          .createHash("sha256")
          .update(contract("source", sourceExtension))
          .digest("hex"),
        replacementBytes: contract("replacement", extension),
        expectedMarker: row.expected.startsWith("dist/")
          ? "built"
          : row.expected.startsWith("dist-runtime/")
            ? "staging"
            : row.expected.includes("/dist/")
              ? "local.js"
              : "source",
      });
    });
    const result = spawnNodeEvalSync(
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
            owner.writePersistedInstalledPluginIndexSync(index, { env });
            const replacement = row.replacementBytes;
            fs.writeFileSync(path.join(row.root, row.expected), replacement);
            assert.equal(snapshot.index.plugins[0].doctorContractHash, row.expectedHash);
          }
        });
        owner.resetPluginCache();
      }
      console.log("doctor-artifacts:18");
    `,
      { timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("doctor-artifacts:18");
    const replacementFixture = fixtures.find((row) => row.name === "built ESM");
    expect(replacementFixture).toBeDefined();
    // Compiled ESM changes take effect after restart, not by evicting require.cache.
    const restarted = spawnNodeEvalSync(
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
      console.log("doctor-artifact-restart:replacement");
    `,
      { timeout: 30_000 },
    );
    expect(restarted.error).toBeUndefined();
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stdout.trim()).toBe("doctor-artifact-restart:replacement");
  }, 60_000);
});
