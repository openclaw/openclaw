import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";

export function createPluginModuleGenerationTestHarness() {
  const temp = useAutoCleanupTempDirTracker(afterEach);
  const instances: PluginInstance[] = [];
  afterEach(async () => {
    for (const instance of instances.splice(0).toReversed()) {
      await instance.dispose();
    }
  });
  function fixture(files: Record<string, string>) {
    const root = temp.make("plugin-native-interop-");
    for (const [name, source] of Object.entries(files)) {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, source);
    }
    return root;
  }
  function host(rootDir: string, standalone = false) {
    let instance: PluginInstance | undefined;
    return {
      load(entry: string): unknown {
        const source = path.join(rootDir, entry);
        if (!instance) {
          instance = new PluginInstance("interop-fixture");
          instances.push(instance);
          const owner = instance;
          withPluginCache(createPluginCache(), () =>
            bindPluginInstanceModuleLoader({
              instance: owner,
              origin: "config",
              source,
              rootDir,
              standalone,
            }),
          );
        }
        return instance.loadModule(source);
      },
      dispose: () => instance?.dispose(),
    };
  }
  return { temp, fixture, host };
}
