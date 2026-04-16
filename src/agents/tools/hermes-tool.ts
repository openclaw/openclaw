import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getOrCreateSessionMcpRuntime } from "../pi-bundle-mcp-runtime.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const HERMES_ACTIONS = [
  "memory_reflect",
  "skill_suggest",
  "long_plan",
  "conversations_list",
  "conversation_get",
  "messages_read",
  "attachments_fetch",
  "events_poll",
  "events_wait",
  "messages_send",
  "channels_list",
  "permissions_list_open",
  "permissions_respond",
  "call",
  "catalog",
  "status",
] as const;

const DEFAULT_ROUTE_TOOLS: Readonly<Record<"memory_reflect" | "skill_suggest" | "long_plan", string>> = {
  memory_reflect: "memory_reflect",
  skill_suggest: "skill_suggest",
  long_plan: "long_plan",
};

const HERMES_ACTION_TOOL_MAP: Readonly<Record<string, string>> = {
  memory_reflect: "memory_reflect",
  skill_suggest: "skill_suggest",
  long_plan: "long_plan",
  conversations_list: "conversations_list",
  conversation_get: "conversation_get",
  messages_read: "messages_read",
  attachments_fetch: "attachments_fetch",
  events_poll: "events_poll",
  events_wait: "events_wait",
  messages_send: "messages_send",
  channels_list: "channels_list",
  permissions_list_open: "permissions_list_open",
  permissions_respond: "permissions_respond",
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
    platform: Type.Optional(Type.String()),
    session_key: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    search: Type.Optional(Type.String()),
    message_id: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    after_cursor: Type.Optional(Type.Number()),
    afterCursor: Type.Optional(Type.Number()),
    timeout_ms: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
    id: Type.Optional(Type.String()),
    decision: Type.Optional(Type.String()),
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

function inferHermesAction(params: Record<string, unknown>): "memory_reflect" | "skill_suggest" | "long_plan" {
  const text = resolvePromptLike(params)?.toLowerCase() ?? "";
  const hasLongPlanSignal =
    /\b(plan|roadmap|milestone|phases?|decompose|strategy|long[-\s]?term|quarter)\b/.test(text);
  if (hasLongPlanSignal) {
    return "long_plan";
  }
  const hasSkillSignal = /\b(skill|workflow|playbook|template|optimi[sz]e|sop|automation)\b/.test(
    text,
  );
  if (hasSkillSignal) {
    return "skill_suggest";
  }
  return "memory_reflect";
}

function buildRouteInput(params: Record<string, unknown>, action: string): Record<string, unknown> {
  const base = resolveRecord(params.input ?? params.arguments);
  const prompt = resolvePromptLike(params);
  if (prompt && !normalizeOptionalString(typeof base.prompt === "string" ? base.prompt : undefined)) {
    base.prompt = prompt;
  }
  if (params.context !== undefined && base.context === undefined) {
    base.context = params.context;
  }

  const sessionKey = readStringParam(params, "session_key") ?? readStringParam(params, "sessionKey");
  if (sessionKey && base.session_key === undefined) {
    base.session_key = sessionKey;
  }
  const messageId = readStringParam(params, "message_id") ?? readStringParam(params, "messageId");
  if (messageId && base.message_id === undefined) {
    base.message_id = messageId;
  }
  const afterCursor = readNumberParam(params, "after_cursor") ?? readNumberParam(params, "afterCursor");
  if (afterCursor !== undefined && base.after_cursor === undefined) {
    base.after_cursor = Math.floor(afterCursor);
  }
  const timeoutMs = readNumberParam(params, "timeout_ms") ?? readNumberParam(params, "timeoutMs");
  if (timeoutMs !== undefined && base.timeout_ms === undefined) {
    base.timeout_ms = Math.floor(timeoutMs);
  }
  const limit = readNumberParam(params, "limit");
  if (limit !== undefined && base.limit === undefined) {
    base.limit = Math.floor(limit);
  }
  const platform = readStringParam(params, "platform");
  if (platform && base.platform === undefined) {
    base.platform = platform;
  }
  const search = readStringParam(params, "search");
  if (search && base.search === undefined) {
    base.search = search;
  }
  const target = readStringParam(params, "target");
  if (target && base.target === undefined) {
    base.target = target;
  }
  const message = readStringParam(params, "message");
  if (message && base.message === undefined) {
    base.message = message;
  }
  const id = readStringParam(params, "id");
  if (id && base.id === undefined) {
    base.id = id;
  }
  const decision = readStringParam(params, "decision");
  if (decision && base.decision === undefined) {
    base.decision = decision;
  }

  if (action === "conversation_get" && !normalizeOptionalString(typeof base.session_key === "string" ? base.session_key : undefined)) {
    throw new ToolInputError("session_key required for hermes action=conversation_get");
  }
  if (action === "messages_read" && !normalizeOptionalString(typeof base.session_key === "string" ? base.session_key : undefined)) {
    throw new ToolInputError("session_key required for hermes action=messages_read");
  }
  if (
    action === "attachments_fetch" &&
    (!normalizeOptionalString(typeof base.session_key === "string" ? base.session_key : undefined) ||
      !normalizeOptionalString(typeof base.message_id === "string" ? base.message_id : undefined))
  ) {
    throw new ToolInputError("session_key and message_id required for hermes action=attachments_fetch");
  }
  if (
    action === "messages_send" &&
    (!normalizeOptionalString(typeof base.target === "string" ? base.target : undefined) ||
      !normalizeOptionalString(typeof base.message === "string" ? base.message : undefined))
  ) {
    throw new ToolInputError("target and message required for hermes action=messages_send");
  }
  if (
    action === "permissions_respond" &&
    (!normalizeOptionalString(typeof base.id === "string" ? base.id : undefined) ||
      !normalizeOptionalString(typeof base.decision === "string" ? base.decision : undefined))
  ) {
    throw new ToolInputError("id and decision required for hermes action=permissions_respond");
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
          | "conversations_list"
          | "conversation_get"
          | "messages_read"
          | "attachments_fetch"
          | "events_poll"
          | "events_wait"
          | "messages_send"
          | "channels_list"
          | "permissions_list_open"
          | "permissions_respond"
          | "call"
          | "catalog"
          | "status"
          | undefined) ?? inferHermesAction(params);
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

      const inputPayload = buildRouteInput(params, action);
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

      const routeToolName = routeTools[action as keyof typeof routeTools] ?? HERMES_ACTION_TOOL_MAP[action];
      if (!routeToolName) {
        throw new ToolInputError(`unsupported hermes action: ${action}`);
      }
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
