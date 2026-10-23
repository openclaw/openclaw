// Verifies plugin install override config and path behavior.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV,
  PLUGIN_INSTALL_OVERRIDES_ENV,
  resolvePluginInstallOverride,
} from "./install-overrides.js";

function resolve(pluginId: string, env: NodeJS.ProcessEnv) {
  vi.stubEnv(ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV, env[ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]);
  vi.stubEnv(PLUGIN_INSTALL_OVERRIDES_ENV, env[PLUGIN_INSTALL_OVERRIDES_ENV]);
  return resolvePluginInstallOverride({ pluginId });
}
afterEach(() => vi.unstubAllEnvs());

describe("plugin install overrides", () => {
  it("requires an explicit allow flag", () => {
    expect(
      resolve("codex", {
        [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({ codex: "npm:@openclaw/codex@1.0.0" }),
      }),
    ).toBeNull();
  });

  it("resolves the matching npm override from a multi-plugin map", () => {
    expect(
      resolve("codex", {
        [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
        [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({
          codex: "npm:@openclaw/codex@2026.5.8",
          "demo-plugin": "npm-pack:./demo.tgz",
        }),
      }),
    ).toEqual({ kind: "npm", spec: "@openclaw/codex@2026.5.8" });
  });

  it("resolves npm-pack paths to absolute archive paths", () => {
    expect(
      resolve("demo-plugin", {
        [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
        [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({
          "demo-plugin": "npm-pack:./demo.tgz",
        }),
      }),
    ).toEqual({ kind: "npm-pack", archivePath: path.resolve("demo.tgz") });
  });

  it("rejects malformed specs", () => {
    expect(
      resolve("codex", {
        [ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]: "1",
        [PLUGIN_INSTALL_OVERRIDES_ENV]: JSON.stringify({ codex: "file:./codex" }),
      }),
    ).toBeNull();
  });
});
