import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const SELF_INFO_ACTIONS = [
  "identity",
  "widget_link",
  "channels",
  "model",
  "config_summary",
] as const;

const SelfInfoToolSchema = Type.Object({
  action: stringEnum(SELF_INFO_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

/**
 * Allowlisted config paths that are safe to expose to any user.
 * Keys are dot-separated paths into the config object.
 */
const SAFE_CONFIG_PATHS = [
  "meta.widgetBaseUrl",
  "meta.widgetTitle",
  "meta.appName",
  "agents.defaults.model",
  "agents.defaults.identity",
  "browser.enabled",
  "ui.seamColor",
  "ui.assistant.name",
  "ui.assistant.avatar",
] as const;

function extractSafeConfigFields(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const path of SAFE_CONFIG_PATHS) {
    const parts = path.split(".");
    let current: unknown = config;
    for (const part of parts) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current !== undefined) {
      result[path] = current;
    }
  }
  return result;
}

function resolveAgentName(agentSessionKey?: string): string | undefined {
  if (!agentSessionKey) {
    return undefined;
  }
  const cfg = loadConfig();
  return resolveSessionAgentId({ sessionKey: agentSessionKey, config: cfg }) ?? undefined;
}

type SelfInfoToolOptions = {
  agentSessionKey?: string;
};

export function createSelfInfoTool(opts?: SelfInfoToolOptions): AnyAgentTool {
  return {
    label: "Self Info",
    name: "self_info",
    description: `Query information about this agent (identity/widget_link/channels/model/config_summary). Use this to answer questions about yourself — your name, widget link, enabled channels, model, or general configuration. Available to all users.

ACTIONS:
- identity: Get agent name, avatar, description, emoji
- widget_link: Get the chat widget URL for this agent
- channels: List enabled channels and their connection status
- model: Get current model selection
- config_summary: Get a safe summary of non-sensitive configuration`,
    parameters: SelfInfoToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      switch (action) {
        case "identity": {
          const result = await callGatewayTool("agent.identity.get", gatewayOpts, {});
          return jsonResult(result);
        }
        case "widget_link": {
          const config = await callGatewayTool<Record<string, unknown>>(
            "config.get",
            gatewayOpts,
            {},
          );
          const meta = config?.meta as Record<string, unknown> | undefined;
          const widgetBaseUrl =
            typeof meta?.widgetBaseUrl === "string" ? meta.widgetBaseUrl.trim() : undefined;
          const agentName = resolveAgentName(opts?.agentSessionKey);
          if (!widgetBaseUrl) {
            return jsonResult({
              ok: false,
              error: "Widget base URL is not configured (meta.widgetBaseUrl).",
            });
          }
          const base = widgetBaseUrl.replace(/\/$/, "");
          const widgetLink = agentName ? `${base}/chat/${agentName}` : base;
          return jsonResult({ ok: true, widgetLink, agentName });
        }
        case "channels": {
          const result = await callGatewayTool("channels.status", gatewayOpts, {});
          return jsonResult(result);
        }
        case "model": {
          const config = await callGatewayTool<Record<string, unknown>>(
            "config.get",
            gatewayOpts,
            {},
          );
          const agents = config?.agents as Record<string, unknown> | undefined;
          const defaults = agents?.defaults as Record<string, unknown> | undefined;
          const model = defaults?.model;
          const agentName = resolveAgentName(opts?.agentSessionKey);
          // Also check for agent-specific model override
          const agentList = agents?.list as Array<Record<string, unknown>> | undefined;
          let agentModel: unknown;
          if (agentName && Array.isArray(agentList)) {
            const agentEntry = agentList.find((a) => a.id === agentName || a.name === agentName);
            agentModel = agentEntry?.model;
          }
          return jsonResult({
            defaultModel: model,
            ...(agentModel !== undefined ? { agentModel } : {}),
            agentName,
          });
        }
        case "config_summary": {
          const config = await callGatewayTool<Record<string, unknown>>(
            "config.get",
            gatewayOpts,
            {},
          );
          const safeFields = extractSafeConfigFields(config);
          // Add channel enabled status
          const channels = config?.channels as Record<string, unknown> | undefined;
          const channelStatus: Record<string, boolean> = {};
          if (channels && typeof channels === "object") {
            for (const [key, value] of Object.entries(channels)) {
              if (value && typeof value === "object" && "enabled" in value) {
                channelStatus[key] = Boolean((value as Record<string, unknown>).enabled);
              }
            }
          }
          return jsonResult({
            ...safeFields,
            channels: channelStatus,
          });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
