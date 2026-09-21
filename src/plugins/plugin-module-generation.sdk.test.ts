import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
});

function load(rootDir: string, entry: string) {
  const instance = new PluginInstance("generation-fixture");
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      source: path.join(rootDir, entry),
      rootDir,
    }),
  );
  return { instance, value: instance.loadModule(path.join(rootDir, entry)) };
}

describe("plugin module generation SDK identity", () => {
  it.skipIf(Boolean(process.versions.bun))(
    "resolves the host SDK in captured workers and recovered generations with native hooks",
    async () => {
      expect(typeof Module.registerHooks).toBe("function");
      const root = temp.make("plugin-sdk-worker-");
      const host = temp.make("plugin-sdk-worker-host-");
      const captures = temp.make("plugin-sdk-worker-captures-");
      fs.mkdirSync(path.join(host, "dist", "plugin-sdk"), { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          bin: { openclaw: "openclaw.mjs" },
          exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
        }),
      );
      fs.writeFileSync(path.join(host, "openclaw.mjs"), "export {};");
      fs.writeFileSync(
        path.join(host, "dist", "plugin-sdk", "core.js"),
        "export const value = 'host SDK';",
      );
      const entry = path.join(root, "index.mjs");
      fs.writeFileSync(
        entry,
        `import { Worker } from 'node:worker_threads';
         export async function read() {
           const worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [] });
           try {
             return await new Promise((resolve, reject) => {
               worker.once('message', resolve);
               worker.once('error', reject);
             });
           } finally {
             await worker.terminate();
           }
         }`,
      );
      fs.writeFileSync(
        path.join(root, "worker.mjs"),
        `import { parentPort } from 'node:worker_threads';
         import { value } from 'openclaw/plugin-sdk/core';
         parentPort.postMessage(value);`,
      );
      const instance = new PluginInstance("sdk-worker");
      instances.push(instance);
      withPluginSourceCaptureDirectory(captures, () =>
        withPluginCache(createPluginCache(), () =>
          bindPluginInstanceModuleLoader({
            instance,
            origin: "global",
            rootDir: root,
            source: entry,
            devSourceRoot: host,
          }),
        ),
      );
      type WorkerModule = { read(): Promise<string> };
      await expect((instance.loadModule(entry) as WorkerModule).read()).resolves.toBe("host SDK");
      const recovery = withPluginSourceCaptureDirectory(captures, () =>
        instance.captureModuleLoaderRecovery(),
      );
      await instance.dispose();
      fs.rmSync(root, { recursive: true });
      const restored = new PluginInstance("sdk-worker");
      instances.push(restored);
      withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
      recovery.dispose();
      await expect((restored.loadModule(entry) as WorkerModule).read()).resolves.toBe("host SDK");
      await restored.dispose();
      expect(fs.readdirSync(captures)).toEqual([]);
      expect(fs.existsSync(path.join(host, "dist", "plugin-sdk", "core.js"))).toBe(true);
    },
  );

  it("keeps lazy canonical SDK imports with their generation cache", async () => {
    const root = temp.make("plugin-sdk-generation-");
    fs.writeFileSync(
      path.join(root, "eager.ts"),
      `export { WEBHOOK_BODY_READ_DEFAULTS as shared } from 'openclaw/plugin-sdk/webhook-request-guards';
       export const resolveSdk = () => import.meta.resolve('openclaw/plugin-sdk/webhook-request-guards');`,
    );
    fs.writeFileSync(
      path.join(root, "lazy.ts"),
      "export const read = async () => (await import('openclaw/plugin-sdk/webhook-request-guards')).WEBHOOK_BODY_READ_DEFAULTS;",
    );
    const previous = getProcessPluginCache();
    try {
      const first = load(root, "eager.ts");
      const firstApi = first.value as { shared: object; resolveSdk(): string };
      const expected = firstApi.shared;
      const sdkUrl = firstApi.resolveSdk();
      expect(expected).toHaveProperty("preAuth");
      const lazy = first.instance.loadModule(path.join(root, "lazy.ts")) as {
        read(): Promise<object>;
      };
      adoptProcessPluginCache(createPluginCache());
      expect(firstApi.resolveSdk()).toBe(sdkUrl);
      expect(await lazy.read()).toBe(expected);
      const second = load(root, "eager.ts");
      expect((second.value as { shared: object }).shared).toBe(expected);
      expect(await lazy.read()).toBe(expected);
      await first.instance.dispose();
      expect(() => firstApi.resolveSdk()).toThrow("reloaded or disabled");
      expect(() => lazy.read()).toThrow("reloaded or disabled");
    } finally {
      adoptProcessPluginCache(previous);
    }
  });
});
