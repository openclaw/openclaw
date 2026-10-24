import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { testing } from "./gateway-mcp-real-transports.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeEntry(root: string, relativePath: string) {
  const entryPath = path.join(root, relativePath);
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "", "utf8");
  return entryPath;
}

it.each([false, true])("resolves channel MCP with packaged output=%s", async (packaged) => {
  const root = tempDirs.make("openclaw-qalab-cli-entry-");
  const channelServerPath = await writeEntry(root, "src/mcp/channel-server.ts");
  const distEntry = packaged ? await writeEntry(root, "dist/index.js") : undefined;
  const mcp = testing.resolveChannelMcpInvocation({
    gatewayToken: "secret-token",
    gatewayUrl: "ws://127.0.0.1:12345",
    repoRoot: root,
    tokenFile: "/tmp/token-file",
  });
  if (packaged) {
    expect(mcp.args).toStrictEqual([
      distEntry,
      "mcp",
      "serve",
      "--url",
      "ws://127.0.0.1:12345",
      "--token-file",
      "/tmp/token-file",
      "--claude-channel-mode",
      "off",
      "--verbose",
    ]);
    expect(mcp.envPatch).toStrictEqual({});
  } else {
    expect(mcp).toMatchObject({ command: process.execPath, cwd: root });
    expect(mcp.args.slice(0, 3)).toStrictEqual(["--import", "tsx", "--eval"]);
    for (const text of [channelServerPath, "serveOpenClawChannelMcp"]) {
      expect(mcp.args[3]).toContain(text);
    }
    expect(mcp.envPatch).toStrictEqual({
      OPENCLAW_QA_GATEWAY_TOKEN: "secret-token",
      OPENCLAW_QA_GATEWAY_URL: "ws://127.0.0.1:12345",
    });
  }
});

it("isolates the source plugin-tools MCP invocation", () => {
  const root = tempDirs.make("openclaw-qalab-cli-entry-");
  const invocation = testing.resolvePluginToolsMcpInvocation({
    configPath: "/tmp/plugin-tools/openclaw.json",
    homeDir: "/tmp/plugin-tools/home",
    repoRoot: root,
    stateDir: "/tmp/plugin-tools/state",
  });

  expect(invocation).toStrictEqual({
    command: process.execPath,
    args: [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "src/mcp/plugin-tools-serve.ts"),
    ],
    cwd: root,
    env: {
      HOME: "/tmp/plugin-tools/home",
      OPENCLAW_CONFIG_PATH: "/tmp/plugin-tools/openclaw.json",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_HOME: "/tmp/plugin-tools/home",
      OPENCLAW_STATE_DIR: "/tmp/plugin-tools/state",
    },
  });
});

it("sets explicit timeouts for each plugin-tools MCP request", async () => {
  const connect = vi.fn().mockResolvedValue(undefined);
  const listTools = vi.fn().mockResolvedValue({ tools: [{ name: "memory_search" }] });
  const callTool = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "MCP fact: the codename is ORBIT-9." }],
    isError: false,
  });
  const client = { callTool, connect, listTools } as unknown as Client;
  const transport = { pid: 42 } as StdioClientTransport;

  await expect(testing.runMcpPluginToolsClientProof({ client, transport })).resolves.toContain(
    "real plugin-tools pid=42",
  );

  for (const [request, args] of [
    [connect, transport],
    [listTools, {}],
    [callTool, { name: "memory_search", arguments: { query: "ORBIT-9 codename", maxResults: 3 } }],
  ] as const) {
    expect(request).toHaveBeenCalledWith(args, { timeout: 180_000 });
  }
});
