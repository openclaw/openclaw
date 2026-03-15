/**
 * OpenClaw MCP Tools
 *
 * Tool definitions and handlers for the MCP server.
 */

import type { OpenClawClient } from "./client.js";

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export const tools: ToolDefinition[] = [
	{
		name: "openclaw_send_message",
		description:
			"Send a message to the OpenClaw agent and receive a response. Use this for conversational interactions, questions, or tasks you want the agent to perform.",
		inputSchema: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "The message to send to the agent",
				},
				session_key: {
					type: "string",
					description:
						"Optional session key to continue an existing conversation. If not provided, a new session is created.",
				},
				thinking: {
					type: "string",
					description:
						"Thinking level for the response: off, low, medium, or high. Default: low",
				},
			},
			required: ["message"],
		},
	},
	{
		name: "openclaw_memory_search",
		description:
			"Search the agent's memory/knowledge base for relevant information. Useful for finding previously stored context, notes, or learned information.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The search query",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default: 10)",
				},
				mode: {
					type: "string",
					description:
						"Search mode: 'search' (keyword), 'vsearch' (vector/semantic), or 'query' (natural language). Default: search",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "openclaw_memory_add",
		description:
			"Add an entry to the agent's persistent memory. Use this to store important information, notes, or context for future reference.",
		inputSchema: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The content to store in memory",
				},
				metadata: {
					type: "object",
					description:
						"Optional metadata to attach to the memory entry (tags, source, etc.)",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "openclaw_agent_status",
		description:
			"Get the current status of the OpenClaw agent, including whether it's running, idle, or has errors.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "openclaw_list_sessions",
		description:
			"List all active sessions for the agent. Sessions represent ongoing conversations or task contexts.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "openclaw_get_session",
		description:
			"Get the transcript of a specific session, showing the conversation history.",
		inputSchema: {
			type: "object",
			properties: {
				session_key: {
					type: "string",
					description: "The session key to retrieve",
				},
			},
			required: ["session_key"],
		},
	},
	{
		name: "openclaw_execute_skill",
		description:
			"Execute a skill (slash command) on the agent. Skills are pre-defined workflows or capabilities like /commit, /review-pr, etc.",
		inputSchema: {
			type: "object",
			properties: {
				skill: {
					type: "string",
					description: "The skill name (without the leading slash)",
				},
				args: {
					type: "string",
					description: "Optional arguments to pass to the skill",
				},
			},
			required: ["skill"],
		},
	},
	{
		name: "openclaw_read_file",
		description:
			"Read a file from the agent's workspace. The workspace contains the agent's working files and context.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file within the workspace",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "openclaw_list_files",
		description:
			"List files in the agent's workspace directory. Useful for discovering available files and context.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Directory path within the workspace (default: root of workspace)",
				},
			},
		},
	},
];

export async function handleToolCall(
	client: OpenClawClient,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	switch (toolName) {
		case "openclaw_send_message": {
			return client.sendMessage({
				message: args.message as string,
				sessionKey: args.session_key as string | undefined,
				thinking: args.thinking as "off" | "low" | "medium" | "high" | undefined,
			});
		}

		case "openclaw_memory_search": {
			return client.searchMemory({
				query: args.query as string,
				limit: args.limit as number | undefined,
				mode: args.mode as "search" | "vsearch" | "query" | undefined,
			});
		}

		case "openclaw_memory_add": {
			const id = await client.addMemory(
				args.content as string,
				args.metadata as Record<string, unknown> | undefined,
			);
			return { success: true, id };
		}

		case "openclaw_agent_status": {
			return client.getStatus();
		}

		case "openclaw_list_sessions": {
			return client.listSessions();
		}

		case "openclaw_get_session": {
			return client.getSessionTranscript(args.session_key as string);
		}

		case "openclaw_execute_skill": {
			return client.executeSkill(args.skill as string, args.args as string | undefined);
		}

		case "openclaw_read_file": {
			return client.readFile(args.path as string);
		}

		case "openclaw_list_files": {
			return client.listFiles(args.path as string | undefined);
		}

		default:
			throw new Error(`Unknown tool: ${toolName}`);
	}
}
