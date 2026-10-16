import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TempPlugin } from "./loader.test-fixtures.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";

export function expectPlugin(registry: PluginRegistry, match: Partial<PluginRecord>) {
  expect(registry.plugins).toContainEqual(expect.objectContaining(match));
}

export function expectOnlyPlugin(registry: PluginRegistry, match: Partial<PluginRecord>) {
  expect(registry.plugins).toEqual([expect.objectContaining(match)]);
}

export function pluginConfig(...plugins: Pick<TempPlugin, "id" | "file">[]) {
  return {
    plugins: {
      allow: plugins.map(({ id }) => id),
      load: { paths: plugins.map(({ file }) => file) },
      slots: { memory: "none" },
    },
  };
}

export function isolatedLoaderEnv(root: string) {
  return {
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  };
}

export function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

export function requireTool(registry: PluginRegistry, config?: OpenClawConfig) {
  const tool = registry.tools[0]!.factory(config ? { config } : {});
  if (!tool || Array.isArray(tool)) {
    throw new Error("Expected one fixture tool");
  }
  return tool;
}
