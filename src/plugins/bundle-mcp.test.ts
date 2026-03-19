import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { isRecord } from "../utils.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import { createBundleMcpTempHarness, createBundleProbePlugin } from "./bundle-mcp.test-support.js";

function getServerArgs(value: unknown): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value.args) ? value.args : undefined;
}

const tempHarness = createBundleMcpTempHarness();

function expectPathRelativeToRoot(
  actual: string | undefined,
  root: string | undefined,
  relative: string,
) {
  expect(typeof actual).toBe("string");
  expect(typeof root).toBe("string");
  if (!actual || !root) {
    return;
  }
  expect(path.normalize(path.relative(root, actual))).toBe(path.normalize(relative));
}

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-bundle-mcp-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const { pluginRoot, serverPath } = await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });
      const resolvedServerPath = await fs.realpath(serverPath);
      const loadedServer = loaded.config.mcpServers.bundleProbe;
      const loadedArgs = getServerArgs(loadedServer);
      const loadedServerPath = typeof loadedArgs?.[0] === "string" ? loadedArgs[0] : undefined;
      const resolvedPluginRoot = await fs.realpath(pluginRoot);

      expect(loaded.diagnostics).toEqual([]);
      expect(isRecord(loadedServer) ? loadedServer.command : undefined).toBe("node");
      expect(loadedArgs).toHaveLength(1);
      expect(loadedServerPath).toBeDefined();
      if (!loadedServerPath) {
        throw new Error("expected bundled MCP args to include the server path");
      }
      expect(await fs.realpath(loadedServerPath)).toBe(resolvedServerPath);
      expect(await fs.realpath(String(loadedServer.cwd))).toBe(resolvedPluginRoot);
    } finally {
      env.restore();
    }
  });

  it("merges inline bundle MCP servers and skips disabled bundles", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-bundle-inline-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-bundle-inline-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const enabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-enabled");
      const disabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-disabled");
      await fs.mkdir(path.join(enabledRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(disabledRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(enabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-enabled",
            mcpServers: {
              enabledProbe: {
                command: "node",
                args: ["./enabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(disabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-disabled",
            mcpServers: {
              disabledProbe: {
                command: "node",
                args: ["./disabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "inline-enabled": { enabled: true },
            "inline-disabled": { enabled: false },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });

      expect(loaded.config.mcpServers.enabledProbe).toBeDefined();
      expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
    } finally {
      env.restore();
    }
  });

  it("resolves inline Claude MCP paths from the plugin root and expands CLAUDE_PLUGIN_ROOT", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-bundle-inline-placeholder-home-");
      const workspaceDir = await tempHarness.createTempDir(
        "openclaw-bundle-inline-placeholder-workspace-",
      );
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "inline-claude");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-claude",
            mcpServers: {
              inlineProbe: {
                command: "${CLAUDE_PLUGIN_ROOT}/bin/server.sh",
                args: ["${CLAUDE_PLUGIN_ROOT}/servers/probe.mjs", "./local-probe.mjs"],
                cwd: "${CLAUDE_PLUGIN_ROOT}",
                env: {
                  PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "inline-claude": { enabled: true },
            },
          },
        },
      });
      expect(loaded.diagnostics).toEqual([]);
      const inlineProbe = loaded.config.mcpServers.inlineProbe;
      expect(isRecord(inlineProbe)).toBe(true);
      if (!isRecord(inlineProbe)) {
        throw new Error("expected inlineProbe config");
      }

      const cwd = typeof inlineProbe.cwd === "string" ? inlineProbe.cwd : undefined;
      const command = typeof inlineProbe.command === "string" ? inlineProbe.command : undefined;
      const args = getServerArgs(inlineProbe);
      const env = isRecord(inlineProbe.env) ? inlineProbe.env : undefined;
      const pluginRootEnv = typeof env?.PLUGIN_ROOT === "string" ? env.PLUGIN_ROOT : undefined;

      expect(cwd).toBeDefined();
      expect(command).toBeDefined();
      expect(args).toHaveLength(2);
      expect(pluginRootEnv).toBe(cwd);
      expectPathRelativeToRoot(command, cwd, path.join("bin", "server.sh"));
      expectPathRelativeToRoot(
        typeof args?.[0] === "string" ? args[0] : undefined,
        cwd,
        path.join("servers", "probe.mjs"),
      );
      expectPathRelativeToRoot(
        typeof args?.[1] === "string" ? args[1] : undefined,
        cwd,
        "local-probe.mjs",
      );
    } finally {
      env.restore();
    }
  });
});
