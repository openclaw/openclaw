import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRadarConfig, parseRadarDefenderCliArgs } from "../context/load-radar-config.js";
import { createRadarDefenderMcpServer } from "./server.js";

async function main() {
  const args = parseRadarDefenderCliArgs(process.argv);
  const config = await loadRadarConfig(args.configPath);
  if ((args.transport ?? config.server.transport) !== "stdio") {
    throw new Error("Only stdio transport is supported in radar-claw-defender v1.");
  }

  const server = createRadarDefenderMcpServer({
    ...config,
    server: {
      ...config.server,
      transport: "stdio",
    },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[radar-claw-defender] MCP server running on stdio`);
}

main().catch((error) => {
  console.error(
    `[radar-claw-defender] Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
