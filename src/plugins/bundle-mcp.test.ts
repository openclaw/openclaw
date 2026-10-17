// Verifies bundled MCP plugin metadata and package output.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { loadEnabledBundleLspConfig } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport, loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import {
  createEnabledPluginEntries,
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  withBundleHomeEnv,
  writeBundleTextFiles,
  writeClaudeBundleManifest,
  resolveBundlePluginRoot,
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

afterEach(async () => {
  await tempHarness.cleanup();
});

function createEnabledBundleConfig(pluginIds: string[]): OpenClawConfig {
  return { plugins: { entries: createEnabledPluginEntries(pluginIds) } };
}

function loadEnabled(workspaceDir: string, pluginId: string) {
  return loadEnabledBundleMcpConfig({ workspaceDir, cfg: createEnabledBundleConfig([pluginId]) });
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

async function writeAgentBundle(params: {
  homeDir: string;
  pluginId: string;
  manifest?: Record<string, unknown>;
  mcp?: unknown;
  textFiles?: Record<string, string>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await writeBundleTextFiles(pluginRoot, {
    "plugin.json": `${JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: params.pluginId, ...params.manifest }, null, 2)}\n`,
    ...(params.mcp === undefined ? {} : { "mcp.json": `${JSON.stringify(params.mcp, null, 2)}\n` }),
    ...params.textFiles,
  });
  return pluginRoot;
}

async function expectInlineBundleMcpServer(params: {
  loadedServer: unknown;
  pluginRoot: string;
  commandRelativePath: string;
  argRelativePaths: readonly string[];
}) {
  assert(isRecord(params.loadedServer));
  const { command, cwd, env } = params.loadedServer;
  const args = getServerArgs(params.loadedServer);
  assert(typeof command === "string" && typeof cwd === "string" && isRecord(env));
  await expectResolvedPathEqual(cwd, params.pluginRoot);
  expect(args).toHaveLength(params.argRelativePaths.length);
  expect(normalizePathForAssertion(path.relative(cwd, command))).toBe(
    normalizePathForAssertion(params.commandRelativePath),
  );
  expect(
    args?.map((entry) =>
      typeof entry === "string" ? normalizePathForAssertion(path.relative(cwd, entry)) : entry,
    ),
  ).toEqual([...params.argRelativePaths]);
  await expectResolvedPathEqual(env.PLUGIN_ROOT, params.pluginRoot);
}

function withBundleFixture(run: Parameters<typeof withBundleHomeEnv>[2]) {
  return withBundleHomeEnv(tempHarness, "openclaw-bundle-mcp", run);
}

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const { pluginRoot, serverPath } = await createBundleProbePlugin(homeDir);

      const loaded = loadEnabled(workspaceDir, "bundle-probe");
      const loadedServer = expectDefined(
        loaded.config.mcpServers.bundleProbe,
        "loaded.config.mcpServers.bundleProbe test invariant",
      );
      const loadedArgs = getServerArgs(loadedServer);
      const loadedServerPath = typeof loadedArgs?.[0] === "string" ? loadedArgs[0] : undefined;

      expectNoDiagnostics(loaded.diagnostics);
      expect(isRecord(loadedServer) ? loadedServer.command : undefined).toBe("node");
      expect(loadedArgs).toHaveLength(1);
      await expectResolvedPathEqual(loadedServerPath, serverPath);
      await expectResolvedPathEqual(loadedServer.cwd, pluginRoot);
    });
  });

  it("loads MCP servers declared by an enabled native plugin", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-native-mcp-workspace-");
    const pluginRoot = await tempHarness.createTempDir("openclaw-native-mcp-plugin-");
    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: createEnabledBundleConfig(["native-mcp"]),
      manifestRegistry: {
        plugins: [
          {
            id: "native-mcp",
            origin: "global",
            format: "openclaw",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginRoot,
            source: path.join(pluginRoot, "index.js"),
            manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
            mcpServers: {
              app: {
                transport: "stdio",
                command: "node",
                args: ["./mcp-server.js"],
              },
              remote: { transport: "streamable-http", url: "https://example.test/mcp" },
              events: { transport: "sse", url: "https://example.test/sse" },
            },
          },
        ],
      },
    });

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers.app).toEqual({
      transport: "stdio",
      command: "node",
      args: [path.join(pluginRoot, "mcp-server.js")],
      cwd: pluginRoot,
    });
    expect(loaded.config.mcpServers.remote).toEqual({
      transport: "streamable-http",
      url: "https://example.test/mcp",
    });
    expect(loaded.config.mcpServers.events).toEqual({
      transport: "sse",
      url: "https://example.test/sse",
    });
  });

  it("normalizes file and inline bundle transports and skips disabled bundles", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
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

      const enabledProbe = loaded.config.mcpServers.enabledProbe;
      const enabledArgs = getServerArgs(enabledProbe);
      expect(isRecord(enabledProbe) ? enabledProbe.command : undefined).toBe("node");
      expect(enabledArgs).toHaveLength(1);
      assert(typeof enabledArgs?.[0] === "string");
      expect(enabledArgs[0]).toContain("enabled.mjs");
      for (const [name, transport] of [
        ["enabledProbe", "stdio"],
        ["inlineHttp", "streamable-http"],
        ["canonical", "sse"],
        ["fileHttp", "streamable-http"],
        ["fileSse", "sse"],
      ] as const) {
        expect(loaded.config.mcpServers[name]).toMatchObject({ transport });
        expect(loaded.config.mcpServers[name]).not.toHaveProperty("type");
        if (transport !== "stdio") {
          expect(loaded.config.mcpServers[name]).not.toHaveProperty("cwd");
        }
      }
      expect(loaded.config.mcpServers.unsupported).toMatchObject({
        type: " CuStOm ",
        transport: "custom",
      });
      expect(loaded.config.mcpServers.explicitTransport).toMatchObject({
        type: "custom",
        transport: "sse",
      });
      const support = inspectBundleMcpRuntimeSupport({
        pluginId: "inline-enabled",
        rootDir: pluginRoot,
        bundleFormat: "claude",
      });
      expect(support.unsupportedServerNames).toEqual(["unsupported"]);
      expect(support.supportedServerNames).toContain("explicitTransport");
      expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
    });
  });

  it("resolves inline Claude MCP paths from the plugin root and expands CLAUDE_PLUGIN_ROOT", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
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
      const loadedServer = loaded.config.mcpServers.inlineProbe;

      expectNoDiagnostics(loaded.diagnostics);
      await expectInlineBundleMcpServer({
        loadedServer,
        pluginRoot,
        commandRelativePath: path.join("bin", "server.sh"),
        argRelativePaths: [
          normalizePathForAssertion(path.join("servers", "probe.mjs"))!,
          normalizePathForAssertion("local-probe.mjs")!,
        ],
      });
    });
  });

  it("reports malformed file-backed MCP configs instead of silently dropping servers", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeClaude(homeDir, "malformed-mcp", {
        mcpServers: ".mcp.json",
      });
      await fs.writeFile(path.join(pluginRoot, ".mcp.json"), "{", "utf-8");

      const loaded = loadEnabled(workspaceDir, "malformed-mcp");

      expect(loaded.config.mcpServers).toStrictEqual({});
      expect(loaded.diagnostics).toHaveLength(1);
      expect(loaded.diagnostics[0]?.pluginId).toBe("malformed-mcp");
      expect(loaded.diagnostics[0]?.message).toContain("unable to read .mcp.json");
    });
  });

  it("reports malformed file-backed LSP configs instead of silently dropping servers", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeClaude(homeDir, "malformed-lsp", {
        lspServers: ".lsp.json",
      });
      await fs.writeFile(path.join(pluginRoot, ".lsp.json"), "{", "utf-8");

      const loaded = loadEnabledBundleLspConfig({
        workspaceDir,
        cfg: createEnabledBundleConfig(["malformed-lsp"]),
      });

      expect(loaded.config.lspServers).toStrictEqual({});
      expect(loaded.diagnostics).toHaveLength(1);
      expect(loaded.diagnostics[0]?.pluginId).toBe("malformed-lsp");
      expect(loaded.diagnostics[0]?.message).toContain("unable to read .lsp.json");
    });
  });

  it("loads Agent Plugins MCP config with placeholders, injected env, and canonical transports", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeAgentBundle({
        homeDir,
        pluginId: "portable-mcp",
        mcp: {
          $schema: AGENT_MCP_SCHEMA,
          mcpServers: {
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
        },
        textFiles: {
          "bin/server": "#!/bin/sh\n",
          "config.json": "{}\n",
        },
      });

      const loaded = loadEnabled(workspaceDir, "portable-mcp");
      const local = expectDefined(loaded.config.mcpServers.local, "local agent MCP server");
      const remote = expectDefined(loaded.config.mcpServers.remote, "remote agent MCP server");
      const legacy = expectDefined(loaded.config.mcpServers.legacy, "legacy agent MCP server");
      const localEnv = isRecord(local.env) ? local.env : {};
      const localArgs = getServerArgs(local);

      expectNoDiagnostics(loaded.diagnostics);
      expect(local).toMatchObject({ transport: "stdio" });
      expect(local.type).toBeUndefined();
      await expectResolvedPathEqual(local.command, path.join(pluginRoot, "bin", "server"));
      await expectResolvedPathEqual(localArgs?.[0], path.join(pluginRoot, "config.json"));
      expect(localArgs?.[1]).toBe(path.join(String(localEnv.PLUGIN_DATA), "cache"));
      await expectResolvedPathEqual(localEnv.PLUGIN_ROOT, pluginRoot);
      const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", "portable-mcp");
      expect(localEnv.PLUGIN_DATA).toBe(pluginDataPath);
      expect(local.cwd).toBe(pluginDataPath);
      expect(loaded.prepareDataDirsByServer).toEqual({
        local: { pluginId: "portable-mcp", dataDir: pluginDataPath },
      });
      await expectPathMissing(pluginDataPath);
      expect(localEnv.ROOT_COPY).toBe(localEnv.PLUGIN_ROOT);
      expect(localEnv.DATA_COPY).toBe(localEnv.PLUGIN_DATA);
      expect(remote).toEqual({
        transport: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" },
      });
      expect(legacy).toEqual({
        transport: "sse",
        url: "https://example.test/sse",
      });
      expect(
        inspectBundleMcpRuntimeSupport({
          pluginId: "portable-mcp",
          rootDir: pluginRoot,
          bundleFormat: "agent",
        }),
      ).toMatchObject({
        supportedServerNames: ["local", "remote", "legacy"],
        stdioServerNames: ["local"],
        unsupportedServerNames: [],
      });
    });
  });

  it("resolves Agent Plugins relative cwd from the plugin root and rejects traversal", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeAgentBundle({
        homeDir,
        pluginId: "portable-cwd",
        mcp: {
          $schema: AGENT_MCP_SCHEMA,
          mcpServers: {
            valid: { type: "stdio", command: "node", cwd: "./child" },
            dotPrefixedChild: { type: "stdio", command: "node", cwd: "./..cache" },
            relativeEscape: { type: "stdio", command: "node", cwd: "./../escape" },
            placeholderEscape: {
              type: "stdio",
              command: "node",
              cwd: "${PLUGIN_ROOT}/../escape",
            },
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
  });

  it("ignores dot MCP config and inline MCP fields for Agent Plugins", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeAgentBundle({
        homeDir,
        pluginId: "closed-agent",
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
      expect(await fs.realpath(pluginRoot)).toBeTruthy();
    });
  });

  it("keeps Agent Plugins inspection pure when PLUGIN_DATA collides", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginId = "data-dir-collision";
      const pluginRoot = await writeAgentBundle({
        homeDir,
        pluginId,
        mcp: {
          $schema: AGENT_MCP_SCHEMA,
          mcpServers: {
            local: { type: "stdio", command: "node" },
            remote: { type: "streamable-http", url: "https://example.test/mcp" },
          },
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
      expect(
        inspectBundleMcpRuntimeSupport({
          pluginId,
          rootDir: pluginRoot,
          bundleFormat: "agent",
        }),
      ).toMatchObject({
        supportedServerNames: ["local", "remote"],
        unsupportedServerNames: [],
      });
      expect((await fs.stat(pluginDataPath)).isFile()).toBe(true);

      const manifest = loadBundleManifest({ rootDir: pluginRoot, bundleFormat: "agent" });
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        expect(manifest.manifest.skills).toEqual(["skills"]);
        expect(manifest.manifest.capabilities).toEqual(
          expect.arrayContaining(["skills", "mcpServers"]),
        );
      }
    });
  });

  it.each([
    { name: "malformed JSON", content: "{" },
    { name: "missing mcpServers", content: JSON.stringify({ $schema: AGENT_MCP_SCHEMA }) },
  ])("isolates Agent Plugins MCP failure for $name", async ({ content }) => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      const pluginRoot = await writeAgentBundle({
        homeDir,
        pluginId: "invalid-agent-mcp",
      });
      await fs.writeFile(path.join(pluginRoot, "mcp.json"), content, "utf-8");

      const loaded = loadEnabled(workspaceDir, "invalid-agent-mcp");

      expect(loaded.config.mcpServers).toStrictEqual({});
      expect(loaded.diagnostics).toHaveLength(1);
      expect(loaded.diagnostics[0]?.pluginId).toBe("invalid-agent-mcp");
      expect(loaded.diagnostics[0]?.message).toContain("mcp.json");
    });
  });

  it("skips invalid Agent Plugins MCP entries while retaining valid siblings", async () => {
    await withBundleFixture(async ({ homeDir, workspaceDir }) => {
      await writeAgentBundle({
        homeDir,
        pluginId: "isolated-agent-mcp",
        mcp: {
          $schema: AGENT_MCP_SCHEMA,
          mcpServers: {
            valid: { type: "streamable-http", url: "https://example.test/mcp" },
            invalid: {
              type: "stdio",
              command: "node --inspect",
              env: { PLUGIN_ROOT: "override" },
            },
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
});
