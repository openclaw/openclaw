import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getOrCreateSessionMcpRuntime } from "../pi-bundle-mcp-runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const HERMES_ACTIONS = ["memory_reflect", "skill_suggest", "long_plan", "call", "catalog", "status"] as const;

const DEFAULT_ROUTE_TOOLS: Readonly<Record<"memory_reflect" | "skill_suggest" | "long_plan", string>> = {
  memory_reflect: "memory_reflect",
  skill_suggest: "skill_suggest",
  long_plan: "long_plan",
};

export const HermesToolSchema = Type.Object(
  {
    action: Type.Optional(Type.Union(HERMES_ACTIONS.map((entry) => Type.Literal(entry)))),
    server: Type.Optional(Type.String()),
    tool: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    input: Type.Optional(Type.Object({}, { additionalProperties: true })),
    arguments: Type.Optional(Type.Object({}, { additionalProperties: true })),
    prompt: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    goal: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    context: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

type HermesToolOptions = {
  sessionId?: string;
  agentSessionKey?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultServer?: string;
  routeToolNames?: Partial<Record<"memory_reflect" | "skill_suggest" | "long_plan", string>>;
};

function resolveRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function resolveRuntimeSessionId(options: HermesToolOptions): string {
  const explicit = normalizeOptionalString(options.sessionId);
  if (explicit) {
    return explicit;
  }
  const bySessionKey = normalizeOptionalString(options.agentSessionKey);
  if (bySessionKey) {
    return bySessionKey;
  }
  return "session:default";
}

function resolveDefaultServer(options: HermesToolOptions): string {
  const explicit = normalizeOptionalString(options.defaultServer);
  if (explicit) {
    return explicit;
  }
  const serverNames = Object.keys(options.config?.mcp?.servers ?? {});
  if (serverNames.includes("hermes")) {
    return "hermes";
  }
  const fuzzy = serverNames.find((name) => /hermes/i.test(name));
  if (fuzzy) {
    return fuzzy;
  }
  return "hermes";
}

function resolvePromptLike(params: Record<string, unknown>): string | undefined {
  return (
    readStringParam(params, "prompt") ??
    readStringParam(params, "message") ??
    readStringParam(params, "goal") ??
    readStringParam(params, "task")
  );
}

function buildRouteInput(params: Record<string, unknown>): Record<string, unknown> {
  const base = resolveRecord(params.input ?? params.arguments);
  const prompt = resolvePromptLike(params);
  if (prompt && !normalizeOptionalString(typeof base.prompt === "string" ? base.prompt : undefined)) {
    base.prompt = prompt;
  }
  if (params.context !== undefined && base.context === undefined) {
    base.context = params.context;
  }
  return base;
}

export function createHermesTool(options: HermesToolOptions): AnyAgentTool {
  const defaultServer = resolveDefaultServer(options);
  const routeTools = {
    ...DEFAULT_ROUTE_TOOLS,
    ...options.routeToolNames,
  };

  return {
    name: "hermes",
    label: "hermes",
    description:
      "Hermes bridge tool via MCP. Supports memory_reflect, skill_suggest, and long_plan routing actions.",
    parameters: HermesToolSchema,
    execute: async (_toolCallId, input) => {
      const params = resolveRecord(input);
      const action =
        (readStringParam(params, "action") as
          | "memory_reflect"
          | "skill_suggest"
          | "long_plan"
          | "call"
          | "catalog"
          | "status"
          | undefined) ?? "memory_reflect";
      const server = readStringParam(params, "server") ?? defaultServer;
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: resolveRuntimeSessionId(options),
        sessionKey: options.agentSessionKey,
        workspaceDir: options.workspaceDir,
        cfg: options.config,
      });

      if (action === "catalog") {
        const catalog = await runtime.getCatalog();
        return jsonResult({
          status: "ok",
          action,
          server,
          catalog: {
            ...catalog,
            tools: catalog.tools.filter((entry) => entry.serverName === server),
            resources: catalog.resources.filter((entry) => entry.serverName === server),
          },
        });
      }

      if (action === "status") {
        const state = await runtime.getServerAuthState(server);
        return jsonResult({
          status: state.status === "connected" ? "ok" : "failed",
          action,
          server: state.server,
          connectionStatus: state.status,
          toolCount: state.toolCount,
          resourceCount: state.resourceCount,
        });
      }

      const inputPayload = buildRouteInput(params);
      if (action === "call") {
        const toolName = readStringParam(params, "toolName") ?? readStringParam(params, "tool");
        if (!toolName) {
          throw new ToolInputError("tool required for hermes action=call");
        }
        const result = await runtime.callTool(server, toolName, inputPayload);
        return jsonResult({
          status: "ok",
          action,
          server,
          toolName,
          result,
        });
      }

      const routeToolName = routeTools[action];
      const result = await runtime.callTool(server, routeToolName, inputPayload);
      return jsonResult({
        status: "ok",
        action,
        server,
        toolName: routeToolName,
        result,
      });
    },
  };
}
