import path from "node:path";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";

export function loadPluginFixture(rootDir: string, entry: string, instances: PluginInstance[]) {
  const source = path.resolve(rootDir, entry);
  const instance = new PluginInstance("generation-fixture");
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      source,
      rootDir,
      standalone: true,
    }),
  );
  return instance.loadModule(source);
}
