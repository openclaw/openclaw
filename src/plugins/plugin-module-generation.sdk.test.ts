import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const execute = promisify(execFile);

function write(root: string, relative: string, content: string): string {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
}

describe("plugin module generation SDK identity", () => {
  it("shares the built host runtime implementation with its public SDK", async () => {
    const runtimeUrl = pathToFileURL(path.resolve("dist/plugins/runtime/index.js")).href;
    const sdkUrl = pathToFileURL(path.resolve("dist/plugin-sdk/command-auth-native.js")).href;
    const { stdout } = await execute(process.execPath, [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
       import { createPluginRuntime } from ${JSON.stringify(runtimeUrl)};
       import { resolveCommandAuthorizedFromAuthorizers } from ${JSON.stringify(sdkUrl)};
       const runtime = createPluginRuntime();
       assert.equal(runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers, resolveCommandAuthorizedFromAuthorizers);
       console.log('shared built host identity');`,
    ]);
    expect(stdout.trim()).toBe("shared built host identity");
  });

  it("preserves real host command authority and Gateway execution frames in the SDK", async () => {
    const root = fs.realpathSync(temp.make("plugin-sdk-host-authority-"));
    const entry = write(
      root,
      "index.ts",
      `export { resolveCommandAuthorization } from 'openclaw/plugin-sdk/command-auth-native';
       import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';
       export const readRequest = () => getPluginRuntimeGatewayRequestScope()?.request;`,
    );
    const moduleUrl = (relative: string) => pathToFileURL(path.resolve(relative)).href;
    const probe = write(
      root,
      "probe.mts",
      `import assert from 'node:assert/strict';
       import { bindPluginInstanceModuleLoader } from ${JSON.stringify(moduleUrl("src/plugins/plugin-instance-module-loader.ts"))};
       import { getCachedPluginModuleLoader } from ${JSON.stringify(moduleUrl("src/plugins/plugin-module-loader-cache.ts"))};
       import { createLazyPluginRuntime } from ${JSON.stringify(moduleUrl("src/plugins/loader-module-runtime.ts"))};
       import { PluginInstance } from ${JSON.stringify(moduleUrl("src/plugins/plugin-instance.ts"))};
       import { bindCommandOwnerAuthority } from ${JSON.stringify(moduleUrl("src/auto-reply/command-owner-authority.ts"))};
       import { resolveCommandAuthorization } from ${JSON.stringify(moduleUrl("src/auto-reply/command-auth.ts"))};
       import { resolveCommandAuthorizedFromAuthorizers } from ${JSON.stringify(moduleUrl("src/channels/command-gating.ts"))};
       import { withPluginRuntimeGatewayRequestScope } from ${JSON.stringify(moduleUrl("src/plugins/runtime/gateway-request-scope.ts"))};
       const instance = new PluginInstance('authority-fixture');
       try {
         bindPluginInstanceModuleLoader({ instance, origin: 'config', source: ${JSON.stringify(entry)}, rootDir: ${JSON.stringify(root)} });
         const managed = instance.loadModule(${JSON.stringify(entry)});
         const transformed = getCachedPluginModuleLoader({ modulePath: ${JSON.stringify(entry)}, importerUrl: ${JSON.stringify(moduleUrl("src/plugins/loader-module-runtime.ts"))}, tryNative: false })(${JSON.stringify(entry)});
         const runtime = createLazyPluginRuntime({});
         assert.equal(runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers, resolveCommandAuthorizedFromAuthorizers);
         let current = true;
         const ctx = { Provider: 'discord', SenderId: 'synthetic-admin' };
         bindCommandOwnerAuthority(ctx, { isCurrent: () => current });
         const scope = { isWebchatConnect: () => false, request: { id: 'synthetic-request' } };
         assert.equal(transformed.resolveCommandAuthorization, resolveCommandAuthorization);
         for (const api of [managed, transformed]) {
           assert.equal(api.resolveCommandAuthorization({ ctx, cfg: {}, commandAuthorized: true }).senderIsOwner, true);
           withPluginRuntimeGatewayRequestScope(scope, () => {
             assert.equal(api.readRequest(), scope.request);
           });
         }
         current = false;
         for (const api of [managed, transformed]) {
           assert.equal(api.resolveCommandAuthorization({ ctx, cfg: {}, commandAuthorized: true }).senderIsOwner, false);
         }
         console.log('host authority preserved');
       } finally { await instance.dispose(); }`,
    );
    const { stdout } = await execute(process.execPath, [
      "--import",
      pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
      probe,
    ]);
    expect(stdout.trim()).toBe("host authority preserved");
  });

  it.each([
    ["src", false],
    ["dist", false],
    ["src", true],
    ["dist", true],
  ] as const)(
    "shares the native %s host owner across plugin generations and recovered workers (legacy loader=%s)",
    async (preference, legacyLoader) => {
      const root = fs.realpathSync(temp.make("plugin-sdk-generation-"));
      const host = path.join(root, "host");
      const hostLink = path.join(root, "host-link");
      write(
        host,
        "package.json",
        JSON.stringify({
          name: "openclaw",
          type: "module",
          bin: { openclaw: "./openclaw.mjs" },
          exports: {
            "./plugin-sdk/identity": "./dist/plugin-sdk/identity.js",
            "./plugin-sdk/identity-peer": "./dist/plugin-sdk/identity-peer.js",
          },
        }),
      );
      for (const [tree, extension] of [
        ["src", "ts"],
        ["dist", "js"],
      ]) {
        write(host, `${tree}/plugin-sdk/identity.${extension}`, 'export * from "./owner.js";');
        write(host, `${tree}/plugin-sdk/identity-peer.${extension}`, 'export * from "./owner.js";');
        write(
          host,
          tree === "dist"
            ? "dist/run-embedded.runtime-abc123.mjs"
            : `${tree}/plugin-sdk/owner.${extension}`,
          `const bindings = new WeakMap();
           export const identity = { tree: ${JSON.stringify(tree)} };
           export const bind = (token, value) => bindings.set(token, value);
           export const read = (token) => bindings.get(token);`,
        );
      }
      write(host, "dist/plugin-sdk/owner.js", 'export * from "../run-embedded.runtime.js";');
      write(
        host,
        "dist/run-embedded.runtime.js",
        'export * from "./run-embedded.runtime-abc123.mjs";',
      );
      fs.symlinkSync(host, hostLink, process.platform === "win32" ? "junction" : "dir");
      const plugin = path.join(root, "plugin");
      const captures = path.join(root, "captures");
      fs.mkdirSync(captures);
      write(plugin, "package.json", JSON.stringify({ name: "fixture", type: "module" }));
      write(
        plugin,
        "eager.ts",
        `import { once } from 'node:events';
         import { Worker } from 'node:worker_threads';
         export * from 'openclaw/plugin-sdk/identity';
         export const generation = {};
         export async function readWorker() {
           const worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [] });
           try {
             const [result] = await once(worker, 'message');
             return result;
           } finally { await worker.terminate(); }
         }
         export const resolveSdk = () => import.meta.resolve('openclaw/plugin-sdk/identity');
         export const readResolvedSdk = () => import(import.meta.resolve('openclaw/plugin-sdk/identity'));`,
      );
      write(
        plugin,
        "worker.mjs",
        `import { parentPort } from 'node:worker_threads';
         import { identity, bind } from 'openclaw/plugin-sdk/identity';
         import { identity as peer, read } from 'openclaw/plugin-sdk/identity-peer';
         const token = {};
         bind(token, 'worker-issued');
         parentPort.postMessage({
           tree: identity.tree, same: identity === peer, binding: read(token),
           url: import.meta.resolve('openclaw/plugin-sdk/identity'),
         });`,
      );
      write(
        plugin,
        "lazy.ts",
        "export const readSdk = () => import('openclaw/plugin-sdk/identity');",
      );
      const moduleUrl = (relative: string) => pathToFileURL(path.resolve(relative)).href;
      const probe = write(
        root,
        "probe.mts",
        `import assert from 'node:assert/strict';
         import fs from 'node:fs';
         import Module from 'node:module';
         ${legacyLoader ? 'Object.defineProperty(Module, "registerHooks", { value: undefined, configurable: true });' : 'if (!process.versions.bun) assert.equal(typeof Module.registerHooks, "function");'}
         const { bindPluginInstanceModuleLoader } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-instance-module-loader.ts"))});
         const { PluginInstance } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-instance.ts"))});
         const { withPluginSourceCaptureDirectory } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-package-metadata-capture.ts"))});
         const { createPluginCache, withPluginCache, adoptProcessPluginCache } = await import(${JSON.stringify(moduleUrl("src/plugins/plugin-cache.ts"))});
         const host = await import(${JSON.stringify(pathToFileURL(path.join(host, preference, "plugin-sdk", `identity.${preference === "src" ? "ts" : "js"}`)).href)});
         const instances = [];
         const captures = ${JSON.stringify(captures)};
         const assertWorker = async (api) => {
           assert.deepEqual(await api.readWorker(), {
             tree: 'dist', same: true, binding: 'worker-issued',
             url: ${JSON.stringify(pathToFileURL(path.join(host, "dist/plugin-sdk/identity.js")).href)},
           });
         };
         const load = () => {
           const instance = new PluginInstance('generation-fixture');
           instances.push(instance);
           withPluginSourceCaptureDirectory(captures, () => withPluginCache(createPluginCache(), () => bindPluginInstanceModuleLoader({
             instance, origin: 'config', rootDir: ${JSON.stringify(plugin)},
             source: ${JSON.stringify(path.join(plugin, "eager.ts"))},
             devSourceRoot: ${JSON.stringify(hostLink)}, pluginSdkResolution: ${JSON.stringify(preference)},
           })));
           return { instance, api: instance.loadModule(${JSON.stringify(path.join(plugin, "eager.ts"))}) };
         };
         try {
           const token = {};
           host.bind(token, 'host-issued');
           const first = load();
           assert.equal(first.api.identity, host.identity);
           assert.equal(first.api.read(token), 'host-issued');
           assert.equal((await first.api.readResolvedSdk()).identity, host.identity);
           await assertWorker(first.api);
           const sdkUrl = first.api.resolveSdk();
           const lazy = first.instance.loadModule(${JSON.stringify(path.join(plugin, "lazy.ts"))});
           adoptProcessPluginCache(createPluginCache());
           const second = load();
           assert.equal(second.api.identity, host.identity);
           assert.notEqual(second.api.generation, first.api.generation);
           assert.equal((await lazy.readSdk()).identity, host.identity);
           second.api.bind(token, 'plugin-written');
           assert.equal(host.read(token), 'plugin-written');
           assert.equal(first.api.resolveSdk(), sdkUrl);
           await first.instance.dispose();
           assert.throws(() => first.api.resolveSdk(), /reloaded or disabled/);
           assert.throws(() => lazy.readSdk(), /reloaded or disabled/);
           assert.equal(second.api.read(token), 'plugin-written');
           await assertWorker(second.api);
           const recovery = withPluginSourceCaptureDirectory(captures, () => second.instance.captureModuleLoaderRecovery());
           await second.instance.dispose();
           fs.rmSync(${JSON.stringify(plugin)}, { recursive: true });
           const restored = new PluginInstance('generation-fixture');
           instances.push(restored);
           try {
             withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
           } finally { recovery.dispose(); }
           await assertWorker(restored.loadModule(${JSON.stringify(path.join(plugin, "eager.ts"))}));
           console.log('shared host identity');
         } finally {
           for (const instance of instances.reverse()) await instance.dispose();
         }
         assert.deepEqual(fs.readdirSync(captures), []);
         assert.equal(fs.existsSync(${JSON.stringify(path.join(host, "dist/plugin-sdk/identity.js"))}), true);`,
      );
      const { stdout } = await execute(process.execPath, [
        "--import",
        pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
        probe,
      ]);
      expect(stdout.trim()).toBe("shared host identity");
    },
  );
});
