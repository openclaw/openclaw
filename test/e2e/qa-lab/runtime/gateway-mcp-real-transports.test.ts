import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { testing } from "./gateway-mcp-real-transports.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRepoRoot() {
  return tempDirs.make("openclaw-qalab-cli-entry-");
}

async function writeEntry(root: string, relativePath: string) {
  const entryPath = path.join(root, relativePath);
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "", "utf8");
  return entryPath;
}

describe("gateway MCP real transport producer", () => {
  it("uses the source channel MCP module when build output is absent", async () => {
    const root = createRepoRoot();
    const channelServerPath = await writeEntry(root, "src/mcp/channel-server.ts");

    const mcp = testing.resolveChannelMcpInvocation({
      gatewayToken: "secret-token",
      gatewayUrl: "ws://127.0.0.1:12345",
      repoRoot: root,
      tokenFile: "/tmp/token-file",
    });

    expect(mcp.command).toBe(process.execPath);
    expect(mcp.args.slice(0, 3)).toStrictEqual(["--import", "tsx", "--eval"]);
    expect(mcp.args[3]).toContain(channelServerPath);
    expect(mcp.args[3]).toContain("serveOpenClawChannelMcp");
    expect(mcp.cwd).toBe(root);
    expect(mcp.envPatch).toStrictEqual({
      OPENCLAW_QA_GATEWAY_TOKEN: "secret-token",
      OPENCLAW_QA_GATEWAY_URL: "ws://127.0.0.1:12345",
    });
  });

  it("uses the packaged CLI for channel MCP when build output exists", async () => {
    const root = createRepoRoot();
    const distEntry = await writeEntry(root, "dist/index.js");
    await writeEntry(root, "src/mcp/channel-server.ts");

    const mcp = testing.resolveChannelMcpInvocation({
      gatewayToken: "secret-token",
      gatewayUrl: "ws://127.0.0.1:12345",
      repoRoot: root,
      tokenFile: "/tmp/token-file",
    });

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
  });
});
