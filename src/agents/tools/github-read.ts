import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, readStringParam } from "./common.js";

const ZREAD_SERVER = "zai-zread";

const GithubReadSchema = Type.Object({
  action: stringEnum(["search_doc", "read_file", "get_repo_structure"], {
    description:
      "search_doc: search docs/issues/commits; read_file: get file content; get_repo_structure: list directory tree",
  }),
  repo: Type.String({
    description: 'GitHub repository in owner/repo format (e.g. "vitejs/vite")',
  }),
  query: Type.Optional(
    Type.String({
      description: "Search keywords or question (required for search_doc)",
    }),
  ),
  file_path: Type.Optional(
    Type.String({
      description: 'Relative file path (required for read_file, e.g. "src/index.ts")',
    }),
  ),
  dir_path: Type.Optional(
    Type.String({
      description: 'Directory path to inspect for get_repo_structure (default: "/")',
    }),
  ),
  language: optionalStringEnum(["en", "zh"], {
    description: "Response language for search_doc (default: en)",
  }),
});

export function createGithubReadTool(): AnyAgentTool {
  return {
    name: "github_read",
    label: "github_read",
    description:
      "Explore GitHub repositories: search docs/issues/commits, read file contents, or browse directory structure. Powered by Z.AI zread.",
    parameters: GithubReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const repo = readStringParam(params, "repo", { required: true });

      if (!action || !["search_doc", "read_file", "get_repo_structure"].includes(action)) {
        throw new ToolInputError(
          "action must be one of: search_doc, read_file, get_repo_structure",
        );
      }
      if (!repo.includes("/")) {
        throw new ToolInputError('repo must be in owner/repo format (e.g. "vitejs/vite")');
      }

      // Build tool arguments for the zai-zread MCP server.
      // This tool is auto-disabled when the native MCP zread server is configured
      // (see openclaw-tools.ts). If enabled, it requires the zai-zread server to
      // be added to tools.mcp.servers — configure it there to use this tool.
      const toolArgs: Record<string, string> = { repo_name: repo };

      if (action === "search_doc") {
        const query = readStringParam(params, "query");
        if (!query) {
          throw new ToolInputError("query is required for search_doc");
        }
        toolArgs["query"] = query;
        const language = readStringParam(params, "language");
        if (language) {
          toolArgs["language"] = language;
        }
      } else if (action === "read_file") {
        const filePath = readStringParam(params, "file_path");
        if (!filePath) {
          throw new ToolInputError("file_path is required for read_file");
        }
        toolArgs["file_path"] = filePath;
      } else if (action === "get_repo_structure") {
        const dirPath = readStringParam(params, "dir_path");
        if (dirPath) {
          toolArgs["dir_path"] = dirPath;
        }
      }

      // github_read requires the native MCP zai-zread server.
      // Add zai-zread to tools.mcp.servers in your config to use this tool.
      throw new ToolInputError(
        `github_read requires the native MCP zai-zread server. ` +
          `Add "${ZREAD_SERVER}" to tools.mcp.servers in your config — ` +
          `the gateway will then expose the equivalent tools via mcp_search.`,
      );
    },
  };
}
