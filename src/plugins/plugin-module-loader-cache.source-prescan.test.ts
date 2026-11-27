import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import * as nativeModule from "./native-module-require.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import * as sourceReferences from "./plugin-source-references.js";
import { getPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

it("resolves repeated SDK requires once per target and loader generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-requires-"));
  const native = vi.spyOn(nativeModule, "tryNativeRequireModule");
  const owners = [createPluginCache(), createPluginCache()] as const;
  const instances = [new PluginInstance("sdk-reuse-first"), new PluginInstance("sdk-reuse-second")];
  const legacy = "openclaw/plugin-sdk/agent-runtime";
  try {
    const first = path.join(root, "first.cjs");
    const second = path.join(root, "second.cjs");
    fs.writeFileSync(first, 'module.exports = { value: "first" };');
    fs.writeFileSync(second, 'module.exports = { value: "second" };');
    let generation = 0;
    const load = (owner: (typeof owners)[number], target: string) => {
      const entry = path.join(root, `entry-${generation++}.ts`);
      fs.writeFileSync(entry, "export function read(id: string) { return require(id); }");
      return withPluginCache(owner, () => {
        const loader = getCachedPluginModuleLoader({
          modulePath: entry,
          importerUrl: import.meta.url,
          tryNative: false,
          aliasMap: {
            [legacy]: target,
            "openclaw/plugin-sdk/alias": target,
          },
        });
        return loader(entry) as { read(id: string): { value: string } };
      });
    };
    const original = load(owners[0], first);
    for (const instance of instances) {
      expect(getPluginSdkDeprecationUsage(instance.pluginId)).toEqual([]);
      instance.run(() => {
        for (let i = 0; i < 50; i++) {
          expect(original.read(legacy).value).toBe("first");
          expect(original.read("openclaw/plugin-sdk/alias").value).toBe("first");
        }
      });
      expect(getPluginSdkDeprecationUsage(instance.pluginId).map(({ id }) => id)).toEqual([legacy]);
    }
    expect(native).toHaveBeenCalledTimes(1);
    const replacement = load(owners[0], second);
    expect(replacement.read(legacy).value).toBe("second");
    expect(original.read(legacy).value).toBe("first");
    expect(native).toHaveBeenCalledTimes(2);
    expect(load(owners[1], first).read(legacy).value).toBe("first");
    expect(native).toHaveBeenCalledTimes(3);
  } finally {
    native.mockRestore();
    for (const instance of instances) {
      await instance.dispose();
    }
    for (const owner of owners) {
      await owner[Symbol.asyncDispose]();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["prepared", "explicit"] as const)(
  "loads a compiled SDK module without source-transform parsing (%s aliases)",
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-prescan-"));
    const owner = createPluginCache();
    const visit = vi.spyOn(sourceReferences, "visitPluginSourceReferences");
    try {
      fs.mkdirSync(path.join(root, "dist", "plugin-sdk"), { recursive: true });
      fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          bin: { openclaw: "openclaw.mjs" },
          exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
        }),
      );
      const sdk = path.join(root, "dist", "plugin-sdk", "core.js");
      fs.writeFileSync(sdk, "export const answer = 42;\n");
      const entry = path.join(root, "entry.mjs");
      fs.writeFileSync(entry, 'export { answer } from "openclaw/plugin-sdk/core";\n');
      const loaded = withPluginCache(owner, () =>
        getCachedPluginModuleLoader({
          modulePath: entry,
          importerUrl: pathToFileURL(entry).href,
          devSourceRoot: root,
          tryNative: true,
          ...(mode === "explicit" ? { aliasMap: { "openclaw/plugin-sdk/core": sdk } } : {}),
        })(entry),
      );
      expect(loaded).toMatchObject({ answer: 42 });
      expect(visit).not.toHaveBeenCalled();
    } finally {
      visit.mockRestore();
      await owner[Symbol.asyncDispose]();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
