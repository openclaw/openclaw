import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadBundledEntryExportSync } from "../../plugin-sdk/channel-entry-contract.js";
import { capturePluginGenerationArtifact } from "../../plugins/plugin-generation-artifact.js";
import { pluginInstanceInvocation } from "../../plugins/plugin-instance-invocation.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.resetModules();
  vi.doUnmock("./bundled-root.js");
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
});

it("loads lazy bundled companions independently of the calling plugin's captured graph", async () => {
  const root = tempDirs.make("openclaw-bundled-instance-");
  const pluginRoot = path.join(root, "extensions", "alpha");
  const builtRoot = path.join(pluginRoot, "dist");
  fs.mkdirSync(path.join(builtRoot, ".setup"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const marker = path.join(root, "evaluated.txt");
  const channelPath = path.join(builtRoot, "channel-plugin-api.js");
  const setupPath = path.join(builtRoot, ".setup", "setup-plugin-api-fixture.mjs");
  for (const [file, label] of [
    [channelPath, "runtime"],
    [setupPath, "setup"],
  ] as const) {
    fs.writeFileSync(
      file,
      `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(marker)}, '${label}\\n');
      export const plugin = { id: 'alpha', meta: { id: 'alpha', label: '${label}' }, capabilities: {}, config: {} };
    `,
    );
  }
  fs.writeFileSync(
    path.join(builtRoot, "runtime-setter-api.js"),
    `
    import fs from 'node:fs';
    export function setRuntime() { fs.appendFileSync(${JSON.stringify(marker)}, 'setter\\n'); }
  `,
  );
  for (const [file, helper, specifier] of [
    ["index.js", "defineBundledChannelEntry", "./channel-plugin-api.js"],
    ["setup-entry.js", "defineBundledChannelSetupEntry", "./.setup/setup-plugin-api-fixture.mjs"],
  ] as const) {
    fs.writeFileSync(
      path.join(builtRoot, file),
      `
      import { ${helper} } from 'openclaw/plugin-sdk/channel-entry-contract';
      export default ${helper}({ id: 'alpha', name: 'Alpha', description: 'Alpha',
        importMetaUrl: import.meta.url,
        runtime: { specifier: './runtime-setter-api.js', exportName: 'setRuntime' }, plugin: { specifier: '${specifier}', exportName: 'plugin' } });
    `,
    );
  }
  // mock-isolation: Resolve bundled channels from the fixture root, not the host package.
  vi.doMock("./bundled-root.js", () => ({
    resolveBundledChannelRootScope: () => ({ packageRoot: root, cacheKey: root }),
  }));
  // mock-isolation: Expose only the fixture channel so no host plugin metadata is scanned.
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [
      {
        dirName: "alpha",
        rootDir: pluginRoot,
        manifest: { id: "alpha", channels: ["alpha"] },
        source: { source: "./index.js" },
        setupSource: { source: "./setup-entry.js" },
      },
    ],
    resolveBundledChannelGeneratedPath: (_root: string, entry: { source: string }) =>
      path.resolve(builtRoot, entry.source),
  }));
  const bundled = await import("./bundled.js");
  const callerRoot = path.join(root, "caller");
  fs.mkdirSync(callerRoot);
  fs.writeFileSync(path.join(callerRoot, "index.cjs"), "module.exports = {};");
  const artifact = capturePluginGenerationArtifact(callerRoot);
  const caller = new PluginInstance("caller");
  caller.bindModuleLoader((source) => artifact.resolve(source), artifact.hasSource);
  try {
    // Loading the bundled cache must not evaluate either companion.
    expect(fs.existsSync(marker)).toBe(false);
    withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false }, () =>
      caller.run(() => {
        const gatewayScope = getPluginRuntimeGatewayRequestScope();
        expect(caller.hasModuleSource(channelPath)).toBe(false);
        expect(() =>
          loadBundledEntryExportSync(pathToFileURL(path.join(builtRoot, "index.js")).href, {
            specifier: "./channel-plugin-api.js",
            exportName: "plugin",
          }),
        ).toThrow("outside the plugin's captured module graph");
        expect.soft(bundled.getBundledChannelPlugin("alpha")?.meta.label).toBe("runtime");
        expect.soft(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("setup");
        bundled.setBundledChannelRuntime("alpha", {} as PluginRuntime);
        expect(pluginInstanceInvocation.getStore()?.instance).toBe(caller);
        expect(getPluginRuntimeGatewayRequestScope()).toBe(gatewayScope);
        expect(caller.hasModuleSource(channelPath)).toBe(false);
      }),
    );
    expect(fs.readFileSync(marker, "utf8")).toBe("runtime\nsetup\nsetter\n");
    expect.soft(bundled.getBundledChannelPlugin("alpha")?.meta.label).toBe("runtime");
    expect.soft(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("setup");
    expect(fs.readFileSync(marker, "utf8")).toBe("runtime\nsetup\nsetter\n");
  } finally {
    await caller.dispose();
    artifact.dispose();
  }
});
