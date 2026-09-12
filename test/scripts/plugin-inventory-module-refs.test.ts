import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import { createPluginInventoryModuleRefsPlugin } from "../../scripts/lib/plugin-inventory-module-refs.mts";
import { buildPluginNpmRuntime } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../../src/plugins/plugin-cache.js";
import { getPluginSetupModuleLoader } from "../../src/plugins/plugin-setup-module.js";
import configs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const requireHost = createRequire(import.meta.url);
const sdk = "openclaw/plugin-sdk/channel-entry-contract";

it.each(["alias", "namespace", "inventory", "unrelated", "esm", "cjs"])(
  "builds only declared SDK companion edges for %s",
  async (binding) => {
    const root = temp.make("inventory companion ");
    const format = binding === "esm" || binding === "cjs" ? binding : undefined;
    const runtimeExtension = format === "cjs" ? "cjs" : "js";
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        type: "module",
        version: "1.0.0",
        openclaw: {
          extensions: ["./companion.ts"],
          setupEntry: "./setup.ts",
          build: { runtimeFormat: format },
        },
      }),
    );
    const event = `inventory:${root}`;
    const companion = path.join(root, "companion.ts");
    fs.writeFileSync(
      companion,
      `import process from 'node:process';
    process.on(${JSON.stringify(event)}, () => {});
    export const channelPlugin = { id: 'fixture' };
    export const runtimeSelectedExport = 'retained';`,
    );
    const entry = path.join(root, "setup.ts");
    const pluginId = binding === "inventory" ? "openai" : "a2a";
    const entryName = `extensions/${pluginId}/${binding === "inventory" ? "setup-api" : "setup-entry"}`;
    const declaration = binding === "namespace" ? "sdk.defineBundledChannelSetupEntry" : "declare";
    fs.writeFileSync(
      entry,
      `#!/usr/bin/env node
    'use strict';
    const __openclawFileURLToPath = 'first';
    const \\u005f_openclawFileURLToPath_ = 'escaped';
    export const retained = [__openclawFileURLToPath, __openclawFileURLToPath_];
    ${binding === "namespace" ? `import * as sdk from '${sdk}';` : `import { defineBundledChannelSetupEntry as ${binding === "unrelated" ? "imported" : "declare"} } from '${sdk}';`}
    ${binding === "unrelated" ? "function declare(value) { return value; }" : ""}
    export const label = '🦞';
    export const decoy = { specifier: './absent.ts' };
    export default ${declaration}({ importMetaUrl: import.meta.url,
      plugin: { specifier: './companion.js', exportName: 'channelPlugin' } });
  `,
    );
    const outDir = path.join(root, "dist");
    const publicApi = path.join(outDir, `extensions/${pluginId}/api.js`);
    fs.mkdirSync(path.dirname(publicApi), { recursive: true });
    fs.writeFileSync(publicApi, "export const nativeOwner = 'unchanged';\n");
    const nativeBytes = fs.readFileSync(publicApi);
    const template = configs.find(
      (config) =>
        config.name === "openclaw-unified" &&
        typeof config.entry === "object" &&
        !Array.isArray(config.entry) &&
        config.entry?.[entryName],
    );
    expect(template).toBeDefined();
    const bundles = format
      ? []
      : (
          await build({
            ...template,
            config: false,
            clean: false,
            entry: {
              [entryName]: entry,
              ...(binding === "inventory"
                ? { "extensions/openai/capability-catalog": companion }
                : {}),
            },
            outDir,
            dts: false,
            logLevel: "silent",
            plugins: [createPluginInventoryModuleRefsPlugin(root)],
          })
        ).bundles;
    if (format) {
      const plan = await buildPluginNpmRuntime({ packageDir: root, logLevel: "silent" });
      expect(plan?.runtimeBuildOutputs).toEqual([
        `./dist/companion.${runtimeExtension}`,
        `./dist/setup.${runtimeExtension}`,
      ]);
      expect(plan?.packageFiles).toContain("dist/**");
    }
    const cache = createPluginCache();
    try {
      if (!format) {
        expect(fs.readFileSync(publicApi)).toEqual(nativeBytes);
      }
      const chunks = bundles.flatMap((bundle) =>
        bundle.chunks.filter((chunk) => chunk.type === "chunk"),
      );
      const privateChunks = chunks.filter((chunk) => chunk.fileName.includes("/.setup/"));
      const setup = path.join(outDir, format ? `setup.${runtimeExtension}` : `${entryName}.js`);
      if (binding === "unrelated") {
        expect(privateChunks).toHaveLength(0);
        expect(fs.readFileSync(setup, "utf8")).not.toContain("new URL(");
        return;
      }
      if (format) {
        const privateFiles = fs.readdirSync(path.join(outDir, ".setup"));
        expect(privateFiles.length).toBeGreaterThan(0);
        expect(
          privateFiles.every((file) => file.endsWith(format === "cjs" ? ".cjs" : ".mjs")),
        ).toBe(true);
        const publicCompanion = requireHost(path.join(outDir, `companion.${runtimeExtension}`)) as {
          channelPlugin: { id: string };
          runtimeSelectedExport: string;
        };
        expect(publicCompanion.runtimeSelectedExport).toBe("retained");
        expect(publicCompanion.channelPlugin.id).toBe("fixture");
      } else {
        expect(privateChunks.length).toBeGreaterThan(0);
        expect(privateChunks.some((chunk) => chunk.exports.includes("runtimeSelectedExport"))).toBe(
          true,
        );
      }
      const nativeListeners = process.listenerCount(event);
      expect(fs.readFileSync(setup, "utf8")).toContain("new URL(");
      if (binding === "inventory") {
        expect(fs.existsSync(path.join(outDir, "extensions/openai/capability-catalog.js"))).toBe(
          true,
        );
      }
      const rootDir = path.dirname(setup);
      const record = {
        id: "fixture",
        origin: "bundled" as const,
        rootDir,
        source: setup,
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        channels: [],
        providers: [],
        cliBackends: [],
        hooks: [],
        skills: [],
      };
      const setupEntry = withPluginCache(cache, () => {
        const loader = getPluginSetupModuleLoader(record, setup, rootDir);
        const module = loader(setup) as {
          default: { loadSetupPlugin(): { id: string } };
          retained: string[];
        };
        expect(module.retained).toEqual(["first", "escaped"]);
        expect(loader.initialize(() => module.default.loadSetupPlugin()).id).toBe("fixture");
        return module.default;
      });
      expect(process.listenerCount(event)).toBe(nativeListeners + 1);
      await retirePluginCache(cache);
      expect(() => setupEntry.loadSetupPlugin()).toThrow("reloaded or disabled");
      expect(process.listenerCount(event)).toBe(nativeListeners + 1);
    } finally {
      await retirePluginCache(cache);
      process.removeAllListeners(event);
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);
