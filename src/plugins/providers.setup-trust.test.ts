import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
  resetPluginLoaderTestStateForTest();
});

describe("setup provider workspace trust", () => {
  it.each([false, true])("imports workspace providers only with explicit trust (%s)", (trusted) => {
    const root = makeTrackedTempDir("openclaw-provider-setup-trust", tempDirs);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const markerDir = path.join(root, "markers");
    const pluginId = "setup-provider";
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
    for (const dir of [pluginRoot, stateDir, markerDir]) {
      mkdirSafeDir(dir);
    }
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        name: "Setup Trust Provider",
        description: "Test workspace provider plugin",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        providers: ["setup"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.cjs"),
      `
const fs = require("node:fs");
const path = require("node:path");
const markerDir = ${JSON.stringify(markerDir)};
fs.mkdirSync(markerDir, { recursive: true });
fs.appendFileSync(path.join(markerDir, "import.txt"), "executed\\n");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    fs.appendFileSync(path.join(markerDir, "register.txt"), "executed\\n");
    api.registerProvider({ id: "setup", label: "Setup Trust Provider", auth: [] });
  },
};`,
    );
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    };
    const expected = { id: "setup", label: "Setup Trust Provider", auth: [], pluginId, pluginRoot };
    withEnv(env, () => {
      expect(
        resolvePluginProvidersCore({
          config: { plugins: trusted ? { allow: [pluginId] } : { enabled: true } },
          workspaceDir,
          env,
          mode: "setup",
          cache: false,
          onlyPluginIds: [pluginId],
        }),
      ).toStrictEqual(trusted ? [expected] : []);
    });
    for (const name of ["import", "register"]) {
      const marker = path.join(markerDir, `${name}.txt`);
      expect(fs.existsSync(marker)).toBe(trusted);
      if (trusted) {
        expect(fs.readFileSync(marker, "utf8")).toBe("executed\n");
      }
    }
  });
});
