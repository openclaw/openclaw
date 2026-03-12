/**
 * OpenClaw MCP Server
 *
 * Exposes OpenClaw capabilities as Model Context Protocol (MCP) tools.
 * This server can be used by Claude Code, Claude Desktop, or any MCP-compatible client.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { OpenClawClient } from "./client.js";
import { tools, handleToolCall } from "./tools.js";

export interface McpServerOptions {
	/** OpenClaw gateway URL (default: http://localhost:18789) */
	gatewayUrl?: string;
	/** Agent ID to use for operations */
	agentId?: string;
	/** Enable debug logging */
	debug?: boolean;
}

export class OpenClawMcpServer {
	private server: Server;
	private client: OpenClawClient;
	private debug: boolean;

	constructor(options: McpServerOptions = {}) {
		this.debug = options.debug ?? false;
		this.client = new OpenClawClient({
			baseUrl: options.gatewayUrl ?? "http://localhost:18789",
			agentId: options.agentId ?? "main",
		});

		this.server = new Server(
			{
				name: "openclaw",
				version: "1.0.0",
			},
			{
				capabilities: {
					tools: {},
				},
			},
		);

		this.setupHandlers();
	}

	private log(message: string, ...args: unknown[]) {
		if (this.debug) {
			console.error(`[openclaw-mcp] ${message}`, ...args);
		}
	}

	private setupHandlers() {
		// List available tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => {
			this.log("Listing tools");
			return { tools: tools as Tool[] };
		});

		// Handle tool calls
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;
			this.log(`Tool call: ${name}`, args);

			try {
				const result = await handleToolCall(this.client, name, args ?? {});
				return {
					content: [
						{
							type: "text" as const,
							text:
								typeof result === "string" ? result : JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.log(`Tool error: ${errorMessage}`);
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${errorMessage}`,
						},
					],
					isError: true,
				};
			}
		});
	}

	async start() {
		const transport = new StdioServerTransport();
		await this.server.connect(transport);
		this.log("OpenClaw MCP server started");
	}
}

// CLI entry point
async function main() {
	const server = new OpenClawMcpServer({
		gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
		agentId: process.env.OPENCLAW_AGENT_ID,
		debug: process.env.OPENCLAW_MCP_DEBUG === "1",
	});

	await server.start();
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
