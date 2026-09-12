import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginInstanceModuleLoader } from "./plugin-module-loader-cache.js";

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
