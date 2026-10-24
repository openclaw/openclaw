import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, describe, expect, it as baseIt } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
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

function getServerArgs(value: unknown): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value.args) ? value.args : undefined;
}

function normalizePathForAssertion(value: string | undefined): string | undefined {
  return value ? path.normalize(value).replace(/\\/g, "/") : value;
}

async function expectResolvedPathEqual(actual: unknown, expected: string): Promise<void> {
  assert(typeof actual === "string");
  expect(normalizePathForAssertion(await fs.realpath(actual))).toBe(
    normalizePathForAssertion(await fs.realpath(expected)),
  );
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function expectNoDiagnostics(diagnostics: unknown[]) {
  expect(diagnostics).toStrictEqual([]);
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

  it("normalizes transports and skips disabled bundles", async ({ homeDir, workspaceDir }) => {
    const pluginRoot = await writeClaude(homeDir, "inline-enabled", {
      mcpServers: {
        enabledProbe: {
          type: " StDiO ",
          command: "node",
          args: ["./enabled.mjs"],
        },
        inlineHttp: { type: "http", url: "https://example.test/inline" },
        canonical: { type: "http", transport: "sse", url: "https://example.test/canonical" },
        unsupported: { type: " CuStOm ", url: "https://example.test/unsupported" },
        explicitTransport: {
          type: "custom",
          transport: "sse",
          url: "https://example.test/explicit",
        },
      },
    });
    await writeBundleTextFiles(pluginRoot, {
      ".mcp.json": JSON.stringify({
        mcpServers: {
          fileHttp: { type: "http", url: "https://example.test/file" },
          fileSse: { type: " SsE ", url: "https://example.test/sse" },
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

    expect(loaded.config.mcpServers).toEqual({
      enabledProbe: {
        transport: "stdio",
        command: "node",
        args: [expect.stringContaining("enabled.mjs")],
        cwd: expect.any(String),
      },
      inlineHttp: { transport: "streamable-http", url: "https://example.test/inline" },
      canonical: { transport: "sse", url: "https://example.test/canonical" },
      fileHttp: { transport: "streamable-http", url: "https://example.test/file" },
      fileSse: { transport: "sse", url: "https://example.test/sse" },
      unsupported: {
        type: " CuStOm ",
        transport: "custom",
        url: "https://example.test/unsupported",
      },
      explicitTransport: { type: "custom", transport: "sse", url: "https://example.test/explicit" },
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

  it("expands inline Claude plugin-root paths", async ({ homeDir, workspaceDir }) => {
    const pluginRoot = await writeClaude(homeDir, "inline-claude", {
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
    });

    const loaded = loadEnabled(workspaceDir, "inline-claude");
    const loadedServer = expectDefined(loaded.config.mcpServers.inlineProbe, "inlineProbe");
    const { command, cwd, env } = loadedServer;
    assert(typeof command === "string" && typeof cwd === "string" && isRecord(env));
    expectNoDiagnostics(loaded.diagnostics);
    await expectResolvedPathEqual(cwd, pluginRoot);
    await expectResolvedPathEqual(env.PLUGIN_ROOT, pluginRoot);
    expect(normalizePathForAssertion(path.relative(cwd, command))).toBe("bin/server.sh");
    expect(
      getServerArgs(loadedServer)?.map((entry) =>
        typeof entry === "string" ? normalizePathForAssertion(path.relative(cwd, entry)) : entry,
      ),
    ).toEqual(["servers/probe.mjs", "local-probe.mjs"]);
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

  it("loads Agent Plugins placeholders, env, and transports", async ({ homeDir, workspaceDir }) => {
    const pluginRoot = await writeAgentBundle(homeDir, "portable-mcp", {
      servers: {
        local: {
          type: "stdio",
          command: "./bin/server",
          args: ["${PLUGIN_ROOT}/config.json", "${PLUGIN_DATA}/cache"],
          env: {
            ROOT_COPY: "${PLUGIN_ROOT}",
            DATA_COPY: "${PLUGIN_DATA}",
          },
          cwd: "${PLUGIN_DATA}",
        },
        remote: {
          type: "streamable-http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer test" },
        },
        legacy: {
          type: "sse",
          url: "https://example.test/sse",
        },
      },
      textFiles: {
        "bin/server": "#!/bin/sh\n",
        "config.json": "{}\n",
      },
    });

    const loaded = loadEnabled(workspaceDir, "portable-mcp");
    const root = await fs.realpath(pluginRoot);
    const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", "portable-mcp");
    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toEqual({
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
      remote: {
        transport: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" },
      },
      legacy: { transport: "sse", url: "https://example.test/sse" },
    });
    expect(loaded.prepareDataDirsByServer).toEqual({
      local: { pluginId: "portable-mcp", dataDir: pluginDataPath },
    });
    await expectPathMissing(pluginDataPath);
    expect(inspectAgent("portable-mcp", pluginRoot)).toMatchObject({
      supportedServerNames: ["local", "remote", "legacy"],
      stdioServerNames: ["local"],
      unsupportedServerNames: [],
    });
  });

  it("resolves Agent Plugins cwd and rejects traversal", async ({ homeDir, workspaceDir }) => {
    const pluginRoot = await writeAgentBundle(homeDir, "portable-cwd", {
      servers: {
        valid: { type: "stdio", command: "node", cwd: "./child" },
        dotPrefixedChild: { type: "stdio", command: "node", cwd: "./..cache" },
        relativeEscape: { type: "stdio", command: "node", cwd: "./../escape" },
        placeholderEscape: {
          type: "stdio",
          command: "node",
          cwd: "${PLUGIN_ROOT}/../escape",
        },
      },
      textFiles: { "child/.keep": "", "..cache/.keep": "" },
    });
    const rootRealPath = await fs.realpath(pluginRoot);
    const relativeProcessCwd = path.relative(rootRealPath, await fs.realpath(process.cwd()));
    expect(relativeProcessCwd === ".." || relativeProcessCwd.startsWith(`..${path.sep}`)).toBe(
      true,
    );
    const loaded = loadEnabled(workspaceDir, "portable-cwd");

    expect(Object.keys(loaded.config.mcpServers)).toEqual(["valid", "dotPrefixedChild"]);
    await expectResolvedPathEqual(
      loaded.config.mcpServers.valid?.cwd,
      path.join(pluginRoot, "child"),
    );
    await expectResolvedPathEqual(
      loaded.config.mcpServers.dotPrefixedChild?.cwd,
      path.join(pluginRoot, "..cache"),
    );
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
          inline: { type: "stdio", command: "node" },
        },
      },
      textFiles: {
        ".mcp.json": JSON.stringify({
          mcpServers: { dotted: { type: "stdio", command: "node" } },
        }),
      },
    });

    const loaded = loadEnabled(workspaceDir, "closed-agent");

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toStrictEqual({});
    await expectPathMissing(path.join(homeDir, ".openclaw", "plugin-data", "closed-agent"));
  });

  it("keeps inspection pure when PLUGIN_DATA collides", async ({ homeDir, workspaceDir }) => {
    const pluginId = "data-dir-collision";
    const pluginRoot = await writeAgentBundle(homeDir, pluginId, {
      servers: {
        local: { type: "stdio", command: "node" },
        remote: { type: "streamable-http", url: "https://example.test/mcp" },
      },
      textFiles: {
        "skills/weather/SKILL.md": "---\nname: weather\ndescription: Weather skill\n---\n",
      },
    });
    const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", pluginId);
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, "directory collision", "utf8");

    const loaded = loadEnabled(workspaceDir, pluginId);

    expect(loaded.config.mcpServers).toEqual({
      local: {
        transport: "stdio",
        command: "node",
        cwd: await fs.realpath(pluginRoot),
        env: {
          PLUGIN_ROOT: await fs.realpath(pluginRoot),
          PLUGIN_DATA: pluginDataPath,
        },
      },
      remote: { transport: "streamable-http", url: "https://example.test/mcp" },
    });
    expect(loaded.diagnostics).toStrictEqual([]);
    expect(loaded.prepareDataDirsByServer).toEqual({
      local: { pluginId, dataDir: pluginDataPath },
    });
    expect(inspectAgent(pluginId, pluginRoot)).toMatchObject({
      supportedServerNames: ["local", "remote"],
      unsupportedServerNames: [],
    });
    expect((await fs.stat(pluginDataPath)).isFile()).toBe(true);
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
        valid: { type: "streamable-http", url: "https://example.test/mcp" },
        invalid: {
          type: "stdio",
          command: "node --inspect",
          env: { PLUGIN_ROOT: "override" },
        },
      },
    });

    const loaded = loadEnabled(workspaceDir, "isolated-agent-mcp");

    expect(loaded.config.mcpServers).toEqual({
      valid: {
        transport: "streamable-http",
        url: "https://example.test/mcp",
      },
    });
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.message).toContain('invalid MCP server "invalid"');
  });
});
