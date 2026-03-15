/**
 * MCP Tool Handlers
 *
 * Implements the actual tool logic, delegating to the gateway client
 * for operations that require gateway communication.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { GatewayClient } from "./client.js";

export interface ToolHandlerContext {
  gatewayUrl: string;
  agentId: string;
  workspace?: string;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export function createToolHandlers(
  context: ToolHandlerContext,
): Record<string, ToolHandler> {
  const client = new GatewayClient({ baseUrl: context.gatewayUrl });

  async function resolveWorkspacePath(relativePath: string): Promise<string> {
    const workspace = context.workspace ?? process.cwd();
    const resolved = path.resolve(workspace, relativePath);

    // Security: ensure path is within workspace
    const normalizedWorkspace = path.resolve(workspace);
    const normalizedResolved = path.resolve(resolved);
    if (!normalizedResolved.startsWith(normalizedWorkspace)) {
      throw new Error("Path escapes workspace boundary");
    }

    return resolved;
  }

  return {
    async openclaw_send_message(args) {
      const message = args.message as string;
      const agentId = (args.agentId as string) ?? context.agentId;
      const sessionKey = args.sessionKey as string | undefined;

      const response = await client.sendMessage({ message, agentId, sessionKey });
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to send message");
      }

      return response.data;
    },

    async openclaw_memory_search(args) {
      const query = args.query as string;
      const limit = args.limit as number | undefined;
      const threshold = args.threshold as number | undefined;

      const response = await client.memorySearch({ query, limit, threshold });
      if (!response.ok) {
        throw new Error(response.error ?? "Memory search failed");
      }

      return response.data;
    },

    async openclaw_memory_add(args) {
      const content = args.content as string;
      const metadata = args.metadata as Record<string, unknown> | undefined;

      const response = await client.memoryAdd({ content, metadata });
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to add memory");
      }

      return response.data;
    },

    async openclaw_agent_status(args) {
      const agentId = (args.agentId as string) ?? context.agentId;

      const response = await client.getAgentStatus(agentId);
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to get agent status");
      }

      return response.data;
    },

    async openclaw_list_sessions(args) {
      const agentId = args.agentId as string | undefined;
      const limit = args.limit as number | undefined;

      const response = await client.listSessions({ agentId, limit });
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to list sessions");
      }

      return response.data;
    },

    async openclaw_get_session(args) {
      const sessionKey = args.sessionKey as string;
      const limit = args.limit as number | undefined;

      const response = await client.getSession({ sessionKey, limit });
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to get session");
      }

      return response.data;
    },

    async openclaw_execute_skill(args) {
      const skill = args.skill as string;
      const skillArgs = args.args as string | undefined;
      const agentId = (args.agentId as string) ?? context.agentId;

      const response = await client.executeSkill({ skill, args: skillArgs, agentId });
      if (!response.ok) {
        throw new Error(response.error ?? "Failed to execute skill");
      }

      return response.data;
    },

    async openclaw_browser_action(args) {
      const action = args.action as string;
      const url = args.url as string | undefined;
      const selector = args.selector as string | undefined;
      const text = args.text as string | undefined;
      const profile = args.profile as string | undefined;

      const response = await client.browserAction({ action, url, selector, text, profile });
      if (!response.ok) {
        throw new Error(response.error ?? "Browser action failed");
      }

      return response.data;
    },

    async openclaw_read_file(args) {
      const filePath = args.path as string;
      const encoding = (args.encoding as BufferEncoding) ?? "utf-8";

      const resolvedPath = await resolveWorkspacePath(filePath);

      try {
        const content = await fs.readFile(resolvedPath, { encoding });
        return { content, path: filePath };
      } catch (err) {
        throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async openclaw_list_files(args) {
      const dirPath = (args.path as string) ?? ".";
      const pattern = args.pattern as string | undefined;

      const resolvedPath = await resolveWorkspacePath(dirPath);

      try {
        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
        let files = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));

        if (pattern) {
          const regex = new RegExp(
            pattern.replace(/\*/g, ".*").replace(/\?/g, "."),
          );
          files = files.filter((f) => regex.test(f.name));
        }

        return { path: dirPath, files };
      } catch (err) {
        throw new Error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
