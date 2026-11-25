import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { snapshotTemplateDependencyDirectory } from "./dependency-directory.js";
import { preflightTemplatePackage } from "./package-preflight.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it("names a bundled plugin's runtime id when only plugins.allow blocks it", async () => {
  const root = dirs.make("template-bundled-plugin-allowlist-");
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  const plugin = path.join(root, "plugins", "gtfs");
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(env.OPENCLAW_STATE_DIR);
  writeJsonFile(path.join(plugin, "package.json"), {
    name: "transit-gtfs-plugin",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  writeJsonFile(path.join(plugin, "openclaw.plugin.json"), {
    id: "transit-gtfs",
    configSchema: { type: "object", properties: {} },
  });
  await fs.writeFile(
    path.join(plugin, "index.js"),
    "export default { id: 'transit-gtfs', register() {} };\n",
  );
  const config = { plugins: { allow: ["other-plugin"] } };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const snapshot = await snapshotTemplateDependencyDirectory({
    rootDir: root,
    path: "plugins/gtfs",
  });

  await withEnvAsync(env, async () => {
    const result = await preflightTemplatePackage(
      { source: "bundled", kind: "plugin", path: "plugins/gtfs" },
      path.join(root, "workspace"),
      { packageRoot: root, snapshot, config, env },
    );
    expect(result).toEqual({
      ok: false,
      code: "plugin_disabled",
      allowlistPluginId: "transit-gtfs",
      message:
        'Plugin plugins/gtfs has plugin id "transit-gtfs", which is not in plugins.allow. Add "transit-gtfs" to plugins.allow before adding this Template.',
    });
  });
});
