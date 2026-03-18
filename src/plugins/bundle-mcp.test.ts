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
      expect(typeof loadedServer.cwd).toBe("string");
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
      const serverCommandPath = path.join(pluginRoot, "bin", "server.sh");
      const serverProbePath = path.join(pluginRoot, "servers", "probe.mjs");
      const localProbePath = path.join(pluginRoot, "local-probe.mjs");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.dirname(serverCommandPath), { recursive: true });
      await fs.mkdir(path.dirname(serverProbePath), { recursive: true });
      await fs.writeFile(serverCommandPath, "#!/bin/sh\n", "utf-8");
      await fs.writeFile(serverProbePath, "export {};\n", "utf-8");
      await fs.writeFile(localProbePath, "export {};\n", "utf-8");
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
      const resolvedPluginRoot = await fs.realpath(pluginRoot);
      const inlineProbe = loaded.config.mcpServers.inlineProbe;
      const inlineArgs = getServerArgs(inlineProbe);
      const inlineCommand =
        isRecord(inlineProbe) && typeof inlineProbe.command === "string"
          ? inlineProbe.command
          : undefined;
      const inlineCwd =
        isRecord(inlineProbe) && typeof inlineProbe.cwd === "string" ? inlineProbe.cwd : undefined;
      const inlineEnvPluginRoot =
        isRecord(inlineProbe) &&
        isRecord(inlineProbe.env) &&
        typeof inlineProbe.env.PLUGIN_ROOT === "string"
          ? inlineProbe.env.PLUGIN_ROOT
          : undefined;

      expect(loaded.diagnostics).toEqual([]);
      expect(inlineCommand).toBeDefined();
      expect(inlineArgs).toHaveLength(2);
      expect(inlineCwd).toBeDefined();
      expect(inlineEnvPluginRoot).toBeDefined();
      expect(await fs.realpath(String(inlineCommand))).toBe(await fs.realpath(serverCommandPath));
      expect(await fs.realpath(String(inlineArgs?.[0]))).toBe(await fs.realpath(serverProbePath));
      expect(await fs.realpath(String(inlineArgs?.[1]))).toBe(await fs.realpath(localProbePath));
      expect(await fs.realpath(String(inlineCwd))).toBe(resolvedPluginRoot);
      expect(await fs.realpath(String(inlineEnvPluginRoot))).toBe(resolvedPluginRoot);
    } finally {
      env.restore();
    }
  });
});
