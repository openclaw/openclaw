import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it as baseIt } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadEnabledBundleLspConfig } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport, loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import {
  createEnabledPluginEntries,
  createBundleMcpTempHarness,
  withBundleHomeEnv,
  writeBundleTextFiles,
  writeClaudeBundleManifest,
  resolveBundlePluginRoot,
} from "./bundle-mcp.test-support.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

async function expectResolvedPathEqual(actual: unknown, expected: string): Promise<void> {
  assert(typeof actual === "string");
  expect(await fs.realpath(actual)).toBe(await fs.realpath(expected));
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function expectNoDiagnostics(diagnostics: unknown[]) {
  expect(diagnostics).toStrictEqual([]);
}

function stdio(fields: Record<string, unknown> = {}) {
  return { type: "stdio", command: "node", ...fields };
}

function remote(type = "streamable-http", endpoint = "mcp", fields: Record<string, unknown> = {}) {
  return { type, url: `https://example.test/${endpoint}`, ...fields };
}

function expectedRemote(
  transport = "streamable-http",
  endpoint = "mcp",
  fields: Record<string, unknown> = {},
) {
  return { transport, url: `https://example.test/${endpoint}`, ...fields };
}

const tempHarness = createBundleMcpTempHarness();

afterEach(() => tempHarness.cleanup());

function createEnabledBundleConfig(pluginIds: string[]): OpenClawConfig {
  return { plugins: { entries: createEnabledPluginEntries(pluginIds) } };
}

function loadEnabled(workspaceDir: string, pluginId: string) {
  return loadEnabledBundleMcpConfig({ workspaceDir, cfg: createEnabledBundleConfig([pluginId]) });
}

function inspectAgent(pluginId: string, rootDir: string) {
  return inspectBundleMcpRuntimeSupport({ pluginId, rootDir, bundleFormat: "agent" });
}

function writeClaude(homeDir: string, pluginId: string, manifest: Record<string, unknown>) {
  return writeClaudeBundleManifest({
    homeDir,
    pluginId,
    manifest: { name: pluginId, ...manifest },
  });
}

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

async function writeAgentBundle(
  homeDir: string,
  pluginId: string,
  params: {
    manifest?: Record<string, unknown>;
    servers?: Record<string, unknown>;
    textFiles?: Record<string, string>;
  },
) {
  const pluginRoot = resolveBundlePluginRoot(homeDir, pluginId);
  await writeBundleTextFiles(pluginRoot, {
    "plugin.json": `${JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: pluginId, ...params.manifest }, null, 2)}\n`,
    ...(params.servers === undefined
      ? {}
      : { "mcp.json": JSON.stringify({ $schema: AGENT_MCP_SCHEMA, mcpServers: params.servers }) }),
    ...params.textFiles,
  });
  return pluginRoot;
}

type BundlePaths = Parameters<Parameters<typeof withBundleHomeEnv>[2]>[0];
const it = baseIt.extend<BundlePaths & { bundle: BundlePaths }>({
  bundle: async ({ task: _task }, use) =>
    withBundleHomeEnv(tempHarness, "openclaw-bundle-mcp", use),
  homeDir: async ({ bundle }, use) => use(bundle.homeDir),
  workspaceDir: async ({ bundle }, use) => use(bundle.workspaceDir),
});

describe("loadEnabledBundleMcpConfig", () => {
  it("loads native plugin MCP declarations", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-native-mcp-workspace-");
    const pluginRoot = await tempHarness.createTempDir("openclaw-native-mcp-plugin-");
    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: createEnabledBundleConfig(["native-mcp"]),
      manifestRegistry: {
        plugins: [
          createPluginManifestRecordFixture({
            id: "native-mcp",
            origin: "global",
            format: "openclaw",
            rootDir: pluginRoot,
            mcpServers: {
              app: {
                transport: "stdio",
                command: "node",
                args: ["./mcp-server.js"],
              },
              remote: { transport: "streamable-http", url: "https://example.test/mcp" },
              events: { transport: "sse", url: "https://example.test/sse" },
            },
          }),
        ],
      },
    });

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toEqual({
      app: {
        transport: "stdio",
        command: "node",
        args: [path.join(pluginRoot, "mcp-server.js")],
        cwd: pluginRoot,
      },
      remote: { transport: "streamable-http", url: "https://example.test/mcp" },
      events: { transport: "sse", url: "https://example.test/sse" },
    });
  });

  it("normalizes Claude transports and paths while skipping disabled bundles", async ({
    homeDir,
    workspaceDir,
  }) => {
    const pluginRoot = await writeClaude(homeDir, "inline-enabled", {
      mcpServers: {
        enabledProbe: stdio({
          type: " StDiO ",
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server.sh",
          args: ["${CLAUDE_PLUGIN_ROOT}/servers/probe.mjs", "./local-probe.mjs"],
          cwd: "${CLAUDE_PLUGIN_ROOT}",
          env: { PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" },
        }),
        inlineHttp: remote("http", "inline"),
        canonical: remote("http", "canonical", { transport: "sse" }),
        unsupported: remote(" CuStOm ", "unsupported"),
        explicitTransport: remote("custom", "explicit", { transport: "sse" }),
      },
    });
    await writeBundleTextFiles(pluginRoot, {
      ".mcp.json": JSON.stringify({
        mcpServers: {
          fileHttp: remote("http", "file"),
          fileSse: remote(" SsE ", "sse"),
        },
      }),
    });
    await writeClaude(homeDir, "inline-disabled", {
      mcpServers: {
        disabledProbe: {
          command: "node",
          args: ["./disabled.mjs"],
        },
      },
    });

    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            ...createEnabledPluginEntries(["inline-enabled"]),
            "inline-disabled": { enabled: false },
          },
        },
      },
    });

    const root = loaded.config.mcpServers.enabledProbe?.cwd;
    assert(typeof root === "string");
    await expectResolvedPathEqual(root, pluginRoot);
    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toEqual({
      enabledProbe: {
        transport: "stdio",
        command: path.join(root, "bin/server.sh"),
        args: [path.join(root, "servers/probe.mjs"), path.join(root, "local-probe.mjs")],
        cwd: root,
        env: { PLUGIN_ROOT: root },
      },
      inlineHttp: expectedRemote("streamable-http", "inline"),
      canonical: expectedRemote("sse", "canonical"),
      fileHttp: expectedRemote("streamable-http", "file"),
      fileSse: expectedRemote("sse", "sse"),
      unsupported: expectedRemote("custom", "unsupported", { type: " CuStOm " }),
      explicitTransport: expectedRemote("sse", "explicit", { type: "custom" }),
    });
    const support = inspectBundleMcpRuntimeSupport({
      pluginId: "inline-enabled",
      rootDir: pluginRoot,
      bundleFormat: "claude",
    });
    expect(support).toEqual({
      unsupportedServerNames: ["unsupported"],
      supportedServerNames: [
        "fileHttp",
        "fileSse",
        "enabledProbe",
        "inlineHttp",
        "canonical",
        "explicitTransport",
      ],
      stdioServerNames: ["enabledProbe"],
      diagnostics: [],
    });
  });

  it.for(["mcp", "lsp"] as const)(
    "reports malformed file-backed %s configs instead of silently dropping servers",
    async (kind, { homeDir, workspaceDir }) => {
      const pluginId = `malformed-${kind}`;
      const file = `.${kind}.json`;
      const pluginRoot = await writeClaude(homeDir, pluginId, { [`${kind}Servers`]: file });
      await fs.writeFile(path.join(pluginRoot, file), "{", "utf-8");
      const params = { workspaceDir, cfg: createEnabledBundleConfig([pluginId]) };
      const loaded =
        kind === "mcp" ? loadEnabledBundleMcpConfig(params) : loadEnabledBundleLspConfig(params);
      expect(Object.values(loaded.config)).toStrictEqual([{}]);
      expect(loaded.diagnostics).toMatchObject([
        { pluginId, message: expect.stringContaining(`unable to read ${file}`) },
      ]);
    },
  );

  it("loads Agent transports and placeholders while rejecting cwd traversal", async ({
    homeDir,
    workspaceDir,
  }) => {
    const pluginRoot = await writeAgentBundle(homeDir, "portable-mcp", {
      servers: {
        local: stdio({
          command: "./bin/server",
          args: ["${PLUGIN_ROOT}/config.json", "${PLUGIN_DATA}/cache"],
          env: {
            ROOT_COPY: "${PLUGIN_ROOT}",
            DATA_COPY: "${PLUGIN_DATA}",
          },
          cwd: "${PLUGIN_DATA}",
        }),
        remote: remote("streamable-http", "mcp", { headers: { Authorization: "Bearer test" } }),
        legacy: remote("sse", "sse"),
        valid: stdio({ cwd: "./child" }),
        dotPrefixedChild: stdio({ cwd: "./..cache" }),
        relativeEscape: stdio({ cwd: "./../escape" }),
        placeholderEscape: stdio({ cwd: "${PLUGIN_ROOT}/../escape" }),
      },
      textFiles: {
        "bin/server": "#!/bin/sh\n",
        "config.json": "{}\n",
        "child/.keep": "",
        "..cache/.keep": "",
      },
    });

    const loaded = loadEnabled(workspaceDir, "portable-mcp");
    const root = await fs.realpath(pluginRoot);
    const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", "portable-mcp");
    expect(Object.keys(loaded.config.mcpServers)).toEqual([
      "local",
      "remote",
      "legacy",
      "valid",
      "dotPrefixedChild",
    ]);
    const { valid, dotPrefixedChild, ...portableServers } = loaded.config.mcpServers;
    expect(portableServers).toEqual({
      local: {
        transport: "stdio",
        command: path.join(root, "bin", "server"),
        args: [path.join(root, "config.json"), path.join(pluginDataPath, "cache")],
        cwd: pluginDataPath,
        env: {
          ROOT_COPY: root,
          DATA_COPY: pluginDataPath,
          PLUGIN_ROOT: root,
          PLUGIN_DATA: pluginDataPath,
        },
      },
      remote: expectedRemote("streamable-http", "mcp", {
        headers: { Authorization: "Bearer test" },
      }),
      legacy: expectedRemote("sse", "sse"),
    });
    expect(loaded.prepareDataDirsByServer).toEqual({
      local: { pluginId: "portable-mcp", dataDir: pluginDataPath },
      valid: { pluginId: "portable-mcp", dataDir: pluginDataPath },
      dotPrefixedChild: { pluginId: "portable-mcp", dataDir: pluginDataPath },
    });
    await expectPathMissing(pluginDataPath);
    expect(inspectAgent("portable-mcp", pluginRoot)).toMatchObject({
      supportedServerNames: ["local", "remote", "legacy", "valid", "dotPrefixedChild"],
      stdioServerNames: ["local", "valid", "dotPrefixedChild"],
      unsupportedServerNames: [],
    });
    const relativeProcessCwd = path.relative(root, await fs.realpath(process.cwd()));
    expect(relativeProcessCwd === ".." || relativeProcessCwd.startsWith(`..${path.sep}`)).toBe(
      true,
    );
    await expectResolvedPathEqual(valid?.cwd, path.join(pluginRoot, "child"));
    await expectResolvedPathEqual(dotPrefixedChild?.cwd, path.join(pluginRoot, "..cache"));
    expect(loaded.diagnostics.map((entry) => entry.message)).toEqual([
      expect.stringContaining('invalid MCP server "relativeEscape"'),
      expect.stringContaining('invalid MCP server "placeholderEscape"'),
    ]);
    expect(loaded.diagnostics.every((entry) => entry.message.includes("cwd must remain"))).toBe(
      true,
    );
  });

  it("ignores dot and inline Agent Plugins MCP config", async ({ homeDir, workspaceDir }) => {
    await writeAgentBundle(homeDir, "closed-agent", {
      manifest: {
        mcpServers: {
          inline: stdio(),
        },
      },
      textFiles: {
        ".mcp.json": JSON.stringify({
          mcpServers: { dotted: stdio() },
        }),
      },
    });

    const loaded = loadEnabled(workspaceDir, "closed-agent");

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toStrictEqual({});
    await expectPathMissing(path.join(homeDir, ".openclaw", "plugin-data", "closed-agent"));
  });

  it.for([
    { name: "malformed JSON", content: "{" },
    { name: "missing mcpServers", content: JSON.stringify({ $schema: AGENT_MCP_SCHEMA }) },
  ])("isolates Agent MCP $name", async ({ content }, { homeDir, workspaceDir }) => {
    const pluginRoot = await writeAgentBundle(homeDir, "invalid-agent-mcp", {});
    await fs.writeFile(path.join(pluginRoot, "mcp.json"), content, "utf-8");

    const loaded = loadEnabled(workspaceDir, "invalid-agent-mcp");

    expect(loaded.config.mcpServers).toStrictEqual({});
    expect(loaded.diagnostics).toEqual([
      { pluginId: "invalid-agent-mcp", message: expect.stringContaining("mcp.json") },
    ]);
  });

  it("isolates invalid Agent Plugins MCP entries", async ({ homeDir, workspaceDir }) => {
    await writeAgentBundle(homeDir, "isolated-agent-mcp", {
      servers: {
        valid: remote(),
        invalid: stdio({ command: "node --inspect", env: { PLUGIN_ROOT: "override" } }),
      },
    });

    const loaded = loadEnabled(workspaceDir, "isolated-agent-mcp");

    expect(loaded.config.mcpServers).toEqual({
      valid: expectedRemote(),
    });
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.message).toContain('invalid MCP server "invalid"');
  });
});
