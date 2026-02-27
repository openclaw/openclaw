import { describe, expect, it } from "vitest";
import { resolvePluginMissingDependencyHint } from "./load-error-hints.js";

describe("resolvePluginMissingDependencyHint", () => {
  it("returns a fix hint for missing package dependencies", () => {
    expect(
      resolvePluginMissingDependencyHint({
        pluginId: "feishu",
        message: "failed to load plugin: Error: Cannot find module '@larksuiteoapi/node-sdk'",
      }),
    ).toBe(
      'Missing dependency "@larksuiteoapi/node-sdk". If this plugin was installed from npm, run "openclaw plugins update feishu". Otherwise reinstall the plugin or run "npm install --omit=dev" in the plugin directory.',
    );
  });

  it("returns placeholder update command when plugin id is unknown", () => {
    expect(
      resolvePluginMissingDependencyHint({
        message:
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /tmp/plugin.js",
      }),
    ).toContain('"openclaw plugins update <plugin-id>"');
  });

  it("ignores relative-path module misses", () => {
    expect(
      resolvePluginMissingDependencyHint({
        pluginId: "example",
        message: "Error: Cannot find module './helpers.js'",
      }),
    ).toBeNull();
  });

  it("returns null for unrelated load failures", () => {
    expect(
      resolvePluginMissingDependencyHint({
        pluginId: "example",
        message: "failed to load plugin: boom",
      }),
    ).toBeNull();
  });
});
