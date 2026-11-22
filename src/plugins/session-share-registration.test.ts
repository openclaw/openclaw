import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(resetPluginRuntimeStateForTest);
it("loads Session Share through the registrar with only the legacy pair default-allowed", () => {
  const registry = loadOpenClawPlugins({
    cache: false,
    activate: false,
    config: {
      plugins: { allow: ["session-share"], entries: { "session-share": { enabled: true } } },
    },
    onlyPluginIds: ["session-share"],
    env: { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions") },
  });
  expect(registry.diagnostics).toEqual([]);
  expect(registry.nodeInvokePolicies.map(({ policy }) => policy.commands)).toEqual([
    ["openclaw.sessions.catalog.list.v1", "openclaw.sessions.catalog.read.v1"],
    ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
  ]);
  setActivePluginRegistry(registry);
  const commands = registry.nodeHostCommands.map(({ command }) => command.command);
  for (const platform of ["linux", "darwin", "win32"]) {
    const allowed = resolveNodeCommandAllowlist(
      {},
      { platform, commands, approvedCommands: commands },
    );
    expect(commands.filter((command) => allowed.has(command))).toEqual([
      "openclaw.sessions.list.v1",
      "openclaw.sessions.read.v1",
    ]);
  }
});
