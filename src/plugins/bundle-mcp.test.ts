import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  withBundleHomeEnv,
} from "./bundle-mcp.test-support.js";

function getServerArgs(value: unknown): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value.args) ? value.args : undefined;
}

function normalizePathForAssertion(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return path.normalize(value).replace(/\\/g, "/");
}

async function expectResolvedPathEqual(actual: unknown, expected: string): Promise<void> {
  expect(typeof actual).toBe("string");
  if (typeof actual !== "string") {
    return;
  }
  expect(normalizePathForAssertion(await fs.realpath(actual))).toBe(
    normalizePathForAssertion(await fs.realpath(expected)),
  );
}

function expectNoDiagnostics(diagnostics: unknown[]) {
  expect(diagnostics).toEqual([]);
}

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

function createEnabledBundleConfig(pluginIds: string[]): OpenClawConfig {
  return {
    plugins: {
      entries: Object.fromEntries(pluginIds.map((pluginId) => [pluginId, { enabled: true }])),
    },
  };
}

async function writeInlineClaudeBundleManifest(params: {
  homeDir: string;
  pluginId: string;
  manifest: Record<string, unknown>;
}) {
  const pluginRoot = path.join(params.homeDir, ".openclaw", "extensions", params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf-8",
  );
  return pluginRoot;
}

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-mcp",
      async ({ homeDir, workspaceDir }) => {
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

        expectNoDiagnostics(loaded.diagnostics);
        expect(isRecord(loadedServer) ? loadedServer.command : undefined).toBe("node");
        expect(loadedArgs).toHaveLength(1);
        expect(loadedServerPath).toBeDefined();
        if (!loadedServerPath) {
          throw new Error("expected bundled MCP args to include the server path");
        }
        expect(normalizePathForAssertion(await fs.realpath(loadedServerPath))).toBe(
          normalizePathForAssertion(resolvedServerPath),
        );
        await expectResolvedPathEqual(loadedServer.cwd, resolvedPluginRoot);
      },
    );
  });

  it("merges inline bundle MCP servers and skips disabled bundles", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-inline",
      async ({ homeDir, workspaceDir }) => {
        await writeInlineClaudeBundleManifest({
          homeDir,
          pluginId: "inline-enabled",
          manifest: {
            name: "inline-enabled",
            mcpServers: {
              enabledProbe: {
                command: "node",
                args: ["./enabled.mjs"],
              },
            },
          },
        });
        await writeInlineClaudeBundleManifest({
          homeDir,
          pluginId: "inline-disabled",
          manifest: {
            name: "inline-disabled",
            mcpServers: {
              disabledProbe: {
                command: "node",
                args: ["./disabled.mjs"],
              },
            },
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: {
            plugins: {
              entries: {
                ...createEnabledBundleConfig(["inline-enabled"]).plugins?.entries,
                "inline-disabled": { enabled: false },
              },
            },
          },
        });

        expect(loaded.config.mcpServers.enabledProbe).toBeDefined();
        expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
      },
    );
  });

  it("resolves inline Claude MCP paths from the plugin root and expands CLAUDE_PLUGIN_ROOT", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-inline-placeholder",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeInlineClaudeBundleManifest({
          homeDir,
          pluginId: "inline-claude",
          manifest: {
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
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["inline-claude"]),
        });
        const loadedServer = loaded.config.mcpServers.inlineProbe;
        const loadedArgs = getServerArgs(loadedServer);
        const loadedCommand = isRecord(loadedServer) ? loadedServer.command : undefined;
        const loadedCwd = isRecord(loadedServer) ? loadedServer.cwd : undefined;
        const loadedEnv =
          isRecord(loadedServer) && isRecord(loadedServer.env) ? loadedServer.env : {};

        expectNoDiagnostics(loaded.diagnostics);
        await expectResolvedPathEqual(loadedCwd, pluginRoot);
        expect(typeof loadedCommand).toBe("string");
        expect(loadedArgs).toHaveLength(2);
        expect(typeof loadedEnv.PLUGIN_ROOT).toBe("string");
        if (typeof loadedCommand !== "string" || typeof loadedCwd !== "string") {
          throw new Error("expected inline bundled MCP server to expose command and cwd");
        }
        expect(normalizePathForAssertion(path.relative(loadedCwd, loadedCommand))).toBe(
          normalizePathForAssertion(path.join("bin", "server.sh")),
        );
        expect(
          loadedArgs?.map((entry) =>
            typeof entry === "string"
              ? normalizePathForAssertion(path.relative(loadedCwd, entry))
              : entry,
          ),
        ).toEqual([
          normalizePathForAssertion(path.join("servers", "probe.mjs")),
          normalizePathForAssertion("local-probe.mjs"),
        ]);
        await expectResolvedPathEqual(loadedEnv.PLUGIN_ROOT, pluginRoot);
      },
    );
  });
});
