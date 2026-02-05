import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, readStringParam } from "../agents/tools/common.js";
import { MCPClient } from "./mcp-client.js";
import { MCPContextManager } from "./context-manager.js";
import { MCPCredentialManager } from "./credential-manager.js";
import type { MCPService } from "./types.js";

const MCPToolCallSchema = Type.Object({
  service: Type.String(),
  toolName: Type.String(),
  arguments: Type.Optional(Type.Any()),
});

/**
 * Create the MCP tool for calling Model Context Protocol services.
 *
 * This tool allows agents to interact with multi-tenant MCP services
 * (HubSpot, BigQuery, Qdrant, MongoDB) while maintaining proper tenant isolation.
 *
 * @param options - Configuration and session context
 * @returns AgentTool for MCP interactions, or null if MCP is disabled
 */
export function createMCPTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg?.mcp?.enabled) {
    return null;
  }

  // Initialize managers
  const contextManager = new MCPContextManager();
  const credentialManager = cfg.mcp.credentials?.mongoUrl
    ? new MCPCredentialManager({
        mongoUrl: cfg.mcp.credentials.mongoUrl,
        database: cfg.mcp.credentials.database || "openclaw_mcp",
        collection: cfg.mcp.credentials.collection || "tenant_credentials",
      })
    : null;

  const mcpClient = new MCPClient({
    credentialManager: credentialManager || undefined,
    servers: cfg.mcp.servers || {},
    toolTimeoutMs: cfg.mcp.toolTimeoutMs || 30000,
  });

  return {
    label: "MCP Tool",
    name: "mcp_call",
    description:
      "Call Model Context Protocol (MCP) services for CRM (HubSpot), analytics (BigQuery), vector search (Qdrant), and document storage (MongoDB). Maintains multi-tenant isolation based on organization/workspace/team context.",
    parameters: MCPToolCallSchema,
    execute: async (_toolCallId, params) => {
      try {
        // Extract parameters
        const service = readStringParam(params, "service", { required: true });
        const toolName = readStringParam(params, "toolName", { required: true });
        const toolArguments = params.arguments || {};

        // Validate service
        const validServices: MCPService[] = ["hubspot", "bigquery", "qdrant", "mongodb"];
        if (!validServices.includes(service as MCPService)) {
          return jsonResult({
            success: false,
            error: `Invalid service: ${service}. Must be one of: ${validServices.join(", ")}`,
          });
        }

        // Extract tenant context from session
        let tenantContext;
        try {
          tenantContext = await contextManager.extractFromSession(options.agentSessionKey);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({
            success: false,
            error: `Failed to extract tenant context: ${message}`,
          });
        }

        // Call the MCP tool
        const result = await mcpClient.callTool(
          tenantContext,
          service as MCPService,
          toolName,
          toolArguments,
        );

        return jsonResult({
          success: true,
          service,
          toolName,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          success: false,
          error: message,
        });
      }
    },
  };
}

/**
 * Create tool for listing available MCP tools.
 *
 * This tool helps agents discover what MCP tools are available
 * for each service, supporting intelligent tool discovery.
 *
 * @param options - Configuration and session context
 * @returns AgentTool for listing MCP tools, or null if MCP is disabled
 */
export function createMCPListToolsTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg?.mcp?.enabled) {
    return null;
  }

  // Initialize managers
  const contextManager = new MCPContextManager();
  const credentialManager = cfg.mcp.credentials?.mongoUrl
    ? new MCPCredentialManager({
        mongoUrl: cfg.mcp.credentials.mongoUrl,
        database: cfg.mcp.credentials.database || "openclaw_mcp",
        collection: cfg.mcp.credentials.collection || "tenant_credentials",
      })
    : null;

  const mcpClient = new MCPClient({
    credentialManager: credentialManager || undefined,
    servers: cfg.mcp.servers || {},
    toolTimeoutMs: cfg.mcp.toolTimeoutMs || 30000,
  });

  const ListToolsSchema = Type.Object({
    service: Type.Optional(Type.String()),
  });

  return {
    label: "MCP List Tools",
    name: "mcp_list_tools",
    description:
      "List available MCP tools for a specific service (hubspot, bigquery, qdrant, mongodb) or all services. Helps discover what operations are available.",
    parameters: ListToolsSchema,
    execute: async (_toolCallId, params) => {
      try {
        const service = readStringParam(params, "service");

        // Extract tenant context
        let tenantContext;
        try {
          tenantContext = await contextManager.extractFromSession(options.agentSessionKey);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({
            success: false,
            error: `Failed to extract tenant context: ${message}`,
          });
        }

        // List tools for specific service or all services
        if (service) {
          const validServices: MCPService[] = ["hubspot", "bigquery", "qdrant", "mongodb"];
          if (!validServices.includes(service as MCPService)) {
            return jsonResult({
              success: false,
              error: `Invalid service: ${service}. Must be one of: ${validServices.join(", ")}`,
            });
          }

          const tools = await mcpClient.listTools(tenantContext, service as MCPService);
          return jsonResult({
            success: true,
            service,
            tools,
          });
        }

        // List all tools
        const allTools: Record<string, unknown> = {};
        const services: MCPService[] = ["hubspot", "bigquery", "qdrant", "mongodb"];

        for (const svc of services) {
          try {
            const tools = await mcpClient.listTools(tenantContext, svc);
            allTools[svc] = tools;
          } catch (err) {
            // If a service fails, continue with others
            allTools[svc] = {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        return jsonResult({
          success: true,
          tools: allTools,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          success: false,
          error: message,
        });
      }
    },
  };
}
