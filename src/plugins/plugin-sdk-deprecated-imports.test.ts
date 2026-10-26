import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeArtifact, writeArtifacts } from "./public-surface.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const execute = promisify(execFile);
const moduleUrl = (relative: string) => pathToFileURL(path.resolve(relative)).href;
const run = (entry: string, args: string[] = [], env = process.env) =>
  execute(process.execPath, ["--import", moduleUrl("scripts/tsx.mjs"), entry, ...args], { env });

it("records a real deprecated member only when the loaded plugin calls it", async () => {
  const root = fs.realpathSync(temp.make("plugin-deprecated-member-"));
  const { stdout, stderr } = await run(
    path.resolve("src/plugins/plugin-sdk-deprecated-member.test-support.ts"),
    [root],
  );
  expect(JSON.parse(stdout)).toHaveLength(1);
  expect(stderr).toContain("[DEP_PLUGIN_SDK]");
});

it.each([false, true])(
  "attributes resolved deprecated imports to their plugin (source transform=%s)",
  async (sourceTransform) => {
    const root = fs.realpathSync(temp.make("plugin-deprecated-imports-"));
    const host = path.join(root, "host");
    const config = JSON.parse(fs.readFileSync(path.resolve("tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    // Keep workspace imports while allowing the synthetic host to own its SDK self-imports.
    const tsconfig = writeArtifact(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        extends: path.resolve("tsconfig.json"),
        compilerOptions: {
          paths: Object.fromEntries(
            Object.entries(config.compilerOptions.paths)
              .filter(([name]) => !name.startsWith("openclaw/"))
              .map(([name, targets]) => [name, targets.map((target) => path.resolve(target))]),
          ),
        },
      }),
    );
    const legacy = "openclaw/plugin-sdk/agent-runtime";
    const active = "openclaw/plugin-sdk/command-auth-native";
    writeArtifacts(host, {
      "package.json": {
        name: "openclaw",
        type: "module",
        bin: { openclaw: "./openclaw.mjs" },
        exports: {
          "./plugin-sdk/agent-runtime": "./dist/plugin-sdk/agent-runtime.js",
          "./plugin-sdk/command-auth-native": "./dist/plugin-sdk/command-auth-native.js",
        },
      },
      "dist/plugin-sdk/agent-runtime.js": "export const value = 'deprecated';",
      "dist/plugin-sdk/command-auth-native.js": `import { value as hostLegacyValue } from 'openclaw/plugin-sdk/agent-runtime';
       export const value = hostLegacyValue === 'deprecated' ? 'active' : 'broken';`,
    });
    const entries = (
      [
        ["synthetic-source", "index.ts", `export { value } from '${legacy}';`],
        ["synthetic-commonjs", "index.cjs", `module.exports = require('${legacy}');`],
        ["synthetic-deferred", "index.ts", `export const read = () => import('${legacy}');`],
        ["synthetic-active", "index.ts", `export { value } from '${active}';`],
      ] as const
    ).map(([id, source, body]) => {
      const directory = path.join(root, id);
      writeArtifacts(directory, { "package.json": { name: id, type: "module" } });
      return { id, directory, entry: writeArtifact(path.join(directory, source), body) };
    });
    const probe = writeArtifact(
      path.join(root, "probe.mts"),
      `import assert from 'node:assert/strict';
       import Module from 'node:module';
       ${sourceTransform ? 'Object.defineProperty(Module, "registerHooks", { value: undefined, configurable: true });' : ""}
       const { bindPluginInstanceModuleLoader } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-instance-module-loader.ts"))});
       const { PluginInstance } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-instance.ts"))});
       const { createPluginCache, withPluginCache } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-cache.ts"))});
       const { getPluginSdkDeprecationUsage } = await import(${JSON.stringify(moduleUrl("src/plugins/sdk-deprecation-usage.ts"))});
       const instances = [];
       try {
         for (const { id, directory, entry } of ${JSON.stringify(entries)}) {
           const instance = new PluginInstance(id);
           instances.push(instance);
           withPluginCache(createPluginCache(), () => bindPluginInstanceModuleLoader({
             instance, origin: 'config', source: entry, rootDir: directory,
             devSourceRoot: ${JSON.stringify(host)}, pluginSdkResolution: 'dist',
           }));
           assert.deepEqual(getPluginSdkDeprecationUsage(id), [], 'binding alone does not use an SDK');
           const api = instance.loadModule(entry);
           if (id === 'synthetic-active') {
             assert.equal(api.value, 'active');
             assert.deepEqual(getPluginSdkDeprecationUsage(id), [], 'active subpaths and their host-internal imports do not deprecate a plugin');
             continue;
           }
           if (id === 'synthetic-deferred') {
             assert.deepEqual(getPluginSdkDeprecationUsage(id), [], 'unexecuted imports are not usage');
             assert.equal((await api.read()).value, 'deprecated');
             assert.equal((await api.read()).value, 'deprecated');
           } else {
             assert.equal(api.value, 'deprecated');
             assert.equal(instance.loadModule(entry).value, 'deprecated');
           }
           assert.deepEqual(getPluginSdkDeprecationUsage(id).map(({ id }) => id), ['openclaw/plugin-sdk/agent-runtime']);
         }
         assert.deepEqual(getPluginSdkDeprecationUsage('unrelated-plugin'), []);
         console.log('deprecated imports attributed once');
       } finally {
         for (const instance of instances.reverse()) await instance.dispose();
       }`,
    );
    const { stdout } = await run(probe, [], { ...process.env, TSX_TSCONFIG_PATH: tsconfig });
    expect(stdout.trim()).toBe("deprecated imports attributed once");
  },
);
