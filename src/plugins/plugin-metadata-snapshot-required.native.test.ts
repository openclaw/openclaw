import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

it("loads canonical marker policy on the first native SDK call without a prepared owner", async ({
  signal,
}) => {
  await lifetime.run(async () => {
    const root = lifetime.createTempDir("openclaw-marker-native-");
    const bundled = path.join(root, "bundled");
    const plugin = path.join(bundled, "marker-fixture");
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "@fixture/marker-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "marker-fixture",
        configSchema: { type: "object" },
        nonSecretAuthMarkers: ["fixture-local"],
        setup: { providers: [{ id: "fixture", envVars: ["FIXTURE_API_KEY"] }] },
        providerUsageAuthEnvVars: { fixture: ["FIXTURE_USAGE_KEY"] },
      }),
    );
    await fs.writeFile(path.join(plugin, "index.js"), 'throw new Error("runtime imported");');
    const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
    const script = `
      import assert from "node:assert/strict";
      const { snapshotReaderSlot } = await import(${moduleUrl("src/plugins/plugin-metadata-snapshot-readers.ts")});
      const { isNonSecretApiKeyMarker: isMarker } = await import(${moduleUrl("src/plugin-sdk/provider-auth-markers.ts")});
      assert.equal(snapshotReaderSlot.listOpenClawPluginManifestMetadata, undefined);
      assert.equal(snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore, undefined);
      assert.equal(isMarker("ollama-local"), true);
      assert.equal(isMarker("fixture-local"), true);
      assert.equal(isMarker("OPENAI_API_KEY"), true);
      assert.equal(isMarker("FIXTURE_API_KEY"), true);
      assert.equal(isMarker("FIXTURE_USAGE_KEY"), true);
      assert.equal(isMarker("FIXTURE_API_KEY", { includeEnvVarName: false }), false);
      assert.equal(isMarker("ARBITRARY_ALL_CAPS"), false);
      assert.equal(isMarker("fixture-credential"), false);
      const runtime = await import(${moduleUrl("src/plugins/plugin-metadata-readers.runtime.ts")});
      assert.equal(snapshotReaderSlot.listOpenClawPluginManifestMetadata, runtime.listOpenClawPluginManifestMetadata);
      assert.equal(snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore, runtime.listKnownProviderAuthEnvVarNamesCore);
      assert.equal(runtime.listOpenClawPluginManifestMetadata().find(({ manifest }) => manifest.id === "marker-fixture")?.origin, "bundled");
      process.stdout.write("marker-policy-ok");
    `;
    const result = await lifetime.track(
      runNodeScript(
        ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "--eval", script],
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_DATA_HOME: path.join(root, "data"),
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
          OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          VITEST: "true",
        },
        30_000,
        { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("marker-policy-ok");
  });
});
