import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import {
  cleanupMcpCliTestState,
  clearMcpOAuthCredentials,
  completeMcpOAuthAuthorization,
  createWorkspace,
  lastLogLine,
  mockLog,
  runMcpCommand,
  resetMcpCliTestState,
} from "./mcp-cli.test-harness.js";
import { writeProbeMcpServer } from "./mcp-cli.test-support.js";

async function withMcpHome(run: (home: string, workspaceDir: string) => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-home-", async (home) => {
    const workspaceDir = await createWorkspace();
    vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
    await run(home, workspaceDir);
  });
}

async function writeMcpConfig(home: string, config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(home, ".openclaw", "openclaw.json"),
    `${JSON.stringify(config)}\n`,
    "utf8",
  );
}

async function writeNativeMcpPlugin(
  workspaceDir: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const pluginRoot = path.join(workspaceDir, "test-native-mcp-plugin");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: "@test/test-native-mcp-plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    })}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(pluginRoot, "index.js"), "export default {};\n", "utf8");
  return pluginRoot;
}

describe("mcp cli plugin sources", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
    vi.unstubAllEnvs();
  });

  it("merges enabled plugin MCP sources, redacts secrets, and supports OAuth login/logout", async () => {
    await withMcpHome(async (home, workspaceDir) => {
      const secret = "native-plugin-header-secret";
      const pluginRoot = await writeNativeMcpPlugin(workspaceDir, {
        id: "test-native-mcp",
        configSchema: { type: "object", properties: {} },
        mcpServers: {
          pluginDocs: {
            url: "https://mcp.example.com/plugin",
            transport: "streamable-http",
            auth: "oauth",
            headers: {
              Authorization: `Bearer ${secret}`,
              "statsig-api-key": "statsig-secret",
              "X-API-Key": "x-api-key-secret",
              "Guru-User": "guru@example.test",
            },
          },
        },
      });
      await writeMcpConfig(home, {
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "test-native-mcp": { enabled: true } },
        },
        mcp: { servers: { paused: { enabled: false, command: process.execPath } } },
      });
      completeMcpOAuthAuthorization.mockResolvedValueOnce("authorized");

      await runMcpCommand(["mcp", "list", "--json"]);
      const listOutput = lastLogLine();
      const listed = JSON.parse(listOutput) as Record<string, Record<string, unknown>>;
      expect(listed).toHaveProperty("pluginDocs");
      expect(listed).toHaveProperty("paused");
      expect(listed.pluginDocs?.headers).toEqual({
        Authorization: REDACTED_SENTINEL,
        "statsig-api-key": REDACTED_SENTINEL,
        "X-API-Key": REDACTED_SENTINEL,
        "Guru-User": REDACTED_SENTINEL,
      });
      expect(listOutput).not.toContain(secret);
      expect(listOutput).not.toContain("statsig-secret");
      expect(listOutput).not.toContain("x-api-key-secret");
      expect(listOutput).not.toContain("guru@example.test");

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "pluginDocs", "--json"]);
      const showOutput = lastLogLine();
      expect(JSON.parse(showOutput).headers).toEqual(listed.pluginDocs?.headers);
      expect(showOutput).not.toContain(secret);

      mockLog.mockClear();
      await runMcpCommand(["mcp", "status", "--json"]);
      expect(
        JSON.parse(lastLogLine()).servers.map((server: { name: string }) => server.name),
      ).toEqual(["paused", "pluginDocs"]);

      await runMcpCommand(["mcp", "login", "pluginDocs", "--code", "fixture-code"]);
      expect(completeMcpOAuthAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "pluginDocs",
          serverUrl: "https://mcp.example.com/plugin",
        }),
        expect.objectContaining({ url: "https://mcp.example.com/plugin" }),
        { code: "fixture-code" },
      );
      await runMcpCommand(["mcp", "logout", "pluginDocs"]);
      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "pluginDocs",
          serverUrl: "https://mcp.example.com/plugin",
        }),
      );

      await writeMcpConfig(home, {
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "test-native-mcp": { enabled: true } },
        },
        mcp: {
          servers: {
            paused: { enabled: false, command: process.execPath },
            pluginDocs: {
              enabled: false,
              url: "https://mcp.example.com/plugin",
              transport: "streamable-http",
              auth: "oauth",
            },
          },
        },
      });
      await expect(
        runMcpCommand(["mcp", "login", "pluginDocs", "--code", "fixture-code"]),
      ).rejects.toThrow("__exit__:1");
      expect(completeMcpOAuthAuthorization).toHaveBeenCalledTimes(1);
      clearMcpOAuthCredentials.mockClear();
      await runMcpCommand(["mcp", "logout", "pluginDocs"]);
      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "pluginDocs",
          serverUrl: "https://mcp.example.com/plugin",
        }),
      );

      await writeMcpConfig(home, {
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "test-native-mcp": { enabled: false } },
        },
        mcp: { servers: { paused: { enabled: false, command: process.execPath } } },
      });
      mockLog.mockClear();
      await runMcpCommand(["mcp", "list", "--json"]);
      const disabledPluginList = JSON.parse(lastLogLine()) as Record<string, unknown>;
      expect(disabledPluginList).not.toHaveProperty("pluginDocs");
      expect(disabledPluginList).toHaveProperty("paused");
      await expect(
        runMcpCommand(["mcp", "login", "pluginDocs", "--code", "fixture-code"]),
      ).rejects.toThrow("__exit__:1");
      expect(completeMcpOAuthAuthorization).toHaveBeenCalledTimes(1);
    });
  });

  it("does not report an env-backed native plugin header as a literal secret in doctor", async () => {
    await withMcpHome(async (home, workspaceDir) => {
      vi.stubEnv("OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN", "fixture-token");
      vi.stubEnv("OPENCLAW_NATIVE_MCP_DOCTOR_EMAIL", "user@example.test");
      const pluginRoot = await writeNativeMcpPlugin(workspaceDir, {
        id: "native-mcp-doctor",
        configSchema: { type: "object", properties: {} },
        mcpServers: {
          pluginDocs: {
            url: "https://mcp.example.com/plugin",
            transport: "streamable-http",
            headers: {
              Authorization: "Bearer ${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}",
              "Proxy-Authorization":
                "Basic ${OPENCLAW_NATIVE_MCP_DOCTOR_EMAIL}:${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}",
              "Guru-Token":
                "${OPENCLAW_NATIVE_MCP_DOCTOR_EMAIL}:${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}",
              "X-Session-Token": "Bearer hardcoded-${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}",
              "X-API-Key": "${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}-suffix",
              "X-Secret": "${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN:-fallback-secret}",
              "X-Password": "$${OPENCLAW_NATIVE_MCP_DOCTOR_TOKEN}",
            },
          },
        },
      });
      await writeMcpConfig(home, {
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "native-mcp-doctor": { enabled: true } },
        },
      });

      await runMcpCommand(["mcp", "doctor", "--json"]);

      const result = JSON.parse(lastLogLine()) as {
        ok: boolean;
        servers: Array<{
          name: string;
          ok: boolean;
          issues: Array<{ level: string; message: string }>;
        }>;
      };
      expect(result.ok).toBe(true);
      expect(result.servers).toEqual([{ name: "pluginDocs", ok: true, issues: expect.any(Array) }]);
      const issues = result.servers[0]?.issues ?? [];
      expect(issues).toHaveLength(4);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining(
              "headers.X-Session-Token contains a literal sensitive value",
            ),
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining(
              "headers.X-API-Key contains a literal sensitive value",
            ),
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("headers.X-Secret contains a literal sensitive value"),
          }),
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining(
              "headers.X-Password contains a literal sensitive value",
            ),
          }),
        ]),
      );
      expect(lastLogLine()).not.toContain("fixture-token");
    });
  });

  it("preserves plugin data ownership when probe and doctor launch an Agent bundle", async () => {
    await withMcpHome(async (home, workspaceDir) => {
      const pluginRoot = path.join(workspaceDir, "agent-probe");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "agent-probe",
        }),
      );
      const serverPath = path.join(pluginRoot, "probe.mjs");
      await writeProbeMcpServer(serverPath);
      const source = await fs.readFile(serverPath, "utf8");
      await fs.writeFile(
        serverPath,
        `import { existsSync } from "node:fs";
if (!existsSync(process.env.PLUGIN_DATA ?? "")) process.exit(1);
${source}`,
      );
      await fs.writeFile(
        path.join(pluginRoot, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: {
            dataProbe: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/probe.mjs"] },
          },
        }),
      );
      await writeMcpConfig(home, {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: { load: { paths: [pluginRoot] }, entries: { "agent-probe": { enabled: true } } },
      });
      await runMcpCommand(["mcp", "probe", "dataProbe", "--json"]);
      expect(JSON.parse(lastLogLine()).servers.dataProbe.tools).toBe(1);
      await fs.rmdir(path.join(home, ".openclaw", "plugin-data", "agent-probe"));
      await runMcpCommand(["mcp", "doctor", "dataProbe", "--probe", "--json"]);
      expect(JSON.parse(lastLogLine()).servers).toMatchObject([{ name: "dataProbe", ok: true }]);
    });
  });
});
