import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { buildPluginSdkDeprecationNotices } from "./sdk-deprecation-notices.js";
import { getPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

const root = process.argv[2];
assert.ok(root, "the synthetic plugin requires its own directory");
const entry = path.join(root, "index.ts");
fs.writeFileSync(path.join(root, "package.json"), '{"name":"synthetic-calendar","type":"module"}');
fs.writeFileSync(
  entry,
  `import { resolveCronStorePath } from 'openclaw/plugin-sdk/cron-store-runtime';
   export const read = (storePath: string) => resolveCronStorePath(storePath);`,
);
const instance = new PluginInstance("synthetic-calendar");
try {
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "config",
      source: entry,
      rootDir: root,
      devSourceRoot: fileURLToPath(new URL("../../", import.meta.url)),
      pluginSdkResolution: "src",
    }),
  );
  const api = instance.loadModule(entry) as { read(storePath: string): string };
  assert.deepEqual(getPluginSdkDeprecationUsage(instance.pluginId), []);
  // An explicit partition exercises the public deprecation without reading configuration or SQLite.
  const storePath = path.join(root, "jobs.json");
  assert.equal(api.read(storePath), storePath);
  assert.equal(api.read(storePath), storePath);
  assert.equal(fs.existsSync(storePath), false);
  const apis = getPluginSdkDeprecationUsage(instance.pluginId);
  assert.equal(apis.length, 1);
  const [apiUsage] = apis;
  assert.ok(apiUsage);
  assert.equal(apiUsage.displayName, "resolveCronStorePath");
  assert.equal(apiUsage.replacement, "resolveCronStorePathAsync");
  assert.equal(apiUsage.removeAfter, "2026-12-31");
  process.stdout.write(JSON.stringify(buildPluginSdkDeprecationNotices(instance.pluginId)));
} finally {
  await instance.dispose();
}
