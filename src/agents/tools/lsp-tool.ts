import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createBundleLspToolRuntime } from "../pi-bundle-lsp-runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const LSP_ACTIONS = [
  "hover",
  "definition",
  "references",
  "diagnostics",
  "symbols",
  "completion",
  "format",
] as const;

export const LspToolSchema = Type.Object(
  {
    action: Type.Union(LSP_ACTIONS.map((entry) => Type.Literal(entry))),
    server: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    uri: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    character: Type.Optional(Type.Number()),
    query: Type.Optional(Type.String()),
    includeDeclaration: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

type LspToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
};

function readNumberParam(params: Record<string, unknown>, key: string): number {
  const raw = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ToolInputError(`${key} required`);
  }
  return raw;
}

function resolveDynamicLspToolName(params: {
  action: "hover" | "definition" | "references" | "diagnostics" | "symbols";
  server?: string;
  runtimeToolNames: string[];
}): string | null {
  const prefix =
    params.action === "hover"
      ? "lsp_hover_"
      : params.action === "definition"
        ? "lsp_definition_"
        : params.action === "references"
          ? "lsp_references_"
          : params.action === "diagnostics"
            ? "lsp_diagnostics_"
            : "lsp_symbols_";
  const candidates = params.runtimeToolNames.filter((name) => name.startsWith(prefix));
  if (candidates.length === 0) {
    return null;
  }
  if (params.server?.trim()) {
    const exact = `${prefix}${params.server.trim()}`;
    return candidates.includes(exact) ? exact : null;
  }
  return candidates[0] ?? null;
}

function resolveLspUri(params: Record<string, unknown>, workspaceDir: string): string {
  const explicit = readStringParam(params, "uri");
  if (explicit) {
    return explicit;
  }
  const filePath = readStringParam(params, "path");
  if (!filePath) {
    throw new ToolInputError("uri required");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) {
    return filePath;
  }
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
  return pathToFileURL(absolute).toString();
}

export function createLspTool(options: LspToolOptions): AnyAgentTool {
  return {
    name: "lsp",
    label: "lsp",
    description:
      "Language server bridge for hover/definition/references using configured bundle LSP servers.",
    parameters: LspToolSchema,
    execute: async (_toolCallId, input) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | "hover"
        | "definition"
        | "references"
        | "diagnostics"
        | "symbols"
        | "completion"
        | "format";
      const runtime = await createBundleLspToolRuntime({
        workspaceDir: options.workspaceDir,
        cfg: options.config,
        reservedToolNames: [],
      });
      try {
        if (!["hover", "definition", "references", "diagnostics", "symbols"].includes(action)) {
          return jsonResult({
            status: "failed",
            action,
            error: `lsp action "${action}" is not currently exposed by the bundle LSP bridge`,
          });
        }
        const runtimeToolNames = runtime.tools.map((tool) => tool.name);
        const dynamicName = resolveDynamicLspToolName({
          action,
          server: readStringParam(params, "server"),
          runtimeToolNames,
        });
        if (!dynamicName) {
          return jsonResult({
            status: "failed",
            action,
            error:
              runtime.sessions.length === 0
                ? "no LSP servers available"
                : "no matching LSP tool for action/server",
            availableServers: runtime.sessions.map((entry) => entry.serverName),
          });
        }
        const target = runtime.tools.find((tool) => tool.name === dynamicName);
        if (!target) {
          throw new ToolInputError(`missing dynamic LSP tool: ${dynamicName}`);
        }

        const toolInput: Record<string, unknown> = {};
        if (action === "symbols") {
          toolInput.query = readStringParam(params, "query") ?? "";
        } else {
          toolInput.uri = resolveLspUri(params, options.workspaceDir);
        }
        if (action === "hover" || action === "definition" || action === "references") {
          toolInput.line = readNumberParam(params, "line");
          toolInput.character = readNumberParam(params, "character");
        }
        if (action === "references") {
          toolInput.includeDeclaration =
            typeof params.includeDeclaration === "boolean" ? params.includeDeclaration : true;
        }

        return await target.execute("lsp-dispatch", toolInput);
      } finally {
        await runtime.dispose();
      }
    },
  };
}
