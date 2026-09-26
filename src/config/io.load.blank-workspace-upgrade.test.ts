import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import { loadConfigFromContextAsync } from "./io.load.js";

function createContext(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({
    configPath,
    env,
    homedir: () => root,
    observe: false,
  });
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

describe("saved blank agent workspace config loads across upgrade", () => {
  it("loads a saved config with a blank per-agent workspace (migration removes it, resolver falls back)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          defaults: { workspace: "/tmp/default" },
          entries: { alpha: { workspace: " " } },
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    // The blank per-agent workspace was migrated away: the resolver now inherits
    // the default workspace directory, matching pre-upgrade behavior.
    expect(config.agents?.entries?.alpha?.workspace).toBeUndefined();
    expect(resolveAgentWorkspaceDir(config, "alpha")).toBe(path.resolve("/tmp/default"));
  });

  it("loads a saved config with a blank workspace contributed by an included file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-load-include-"));
    const context = createContext(root);
    fs.writeFileSync(
      path.join(root, "agents.json"),
      JSON.stringify({ agents: { entries: { alpha: { workspace: "   " } } } }),
    );
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        $include: "./agents.json",
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    expect(config.agents?.entries?.alpha?.workspace).toBeUndefined();
    // The included blank was migrated away; the agent falls back to the default
    // shared workspace directory (harness home, not the authored blank).
    expect(resolveAgentWorkspaceDir(config, "alpha")).toMatch(/\.openclaw[\\/]workspace$/u);
  });

  it("loads a saved config with a blank defaults workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-load-default-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: { defaults: { workspace: "   " }, entries: { alpha: {} } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.defaults?.workspace).toBeUndefined();
    expect(resolveAgentWorkspaceDir(config, "alpha")).toMatch(/\.openclaw[\\/]workspace$/u);
  });
});
