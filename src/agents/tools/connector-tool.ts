/**
 * Connector tool: agents can interact with external SaaS platforms.
 *
 * Exposes the connector framework as an agent-callable tool.
 * Built-in connectors: GitHub, Notion, HubSpot.
 * Additional connectors can be registered via the connector framework.
 */

import { Type } from "@sinclair/typebox";
import {
  listConnectors,
  runConnectorOperation,
} from "../../connectors/framework.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const CONNECTOR_ACTIONS = ["list", "run"] as const;

const ConnectorToolSchema = Type.Object({
  action: stringEnum(CONNECTOR_ACTIONS),
  /** Connector ID (e.g., "github", "notion", "hubspot") */
  connectorId: Type.Optional(Type.String()),
  /** Operation name within the connector */
  operation: Type.Optional(Type.String()),
  /** Parameters for the operation */
  params: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** Authentication credentials */
  auth: Type.Optional(
    Type.Object(
      {
        apiKey: Type.Optional(Type.String()),
        token: Type.Optional(Type.String()),
        username: Type.Optional(Type.String()),
        password: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ),
});

export function createConnectorTool(): AnyAgentTool {
  return {
    label: "App Connectors",
    name: "connector",
    description:
      "Connect to external apps and SaaS platforms. " +
      "Use action=list to see available connectors and their operations. " +
      "Use action=run to execute an operation on a specific connector. " +
      "Built-in connectors: github, notion, hubspot.",
    parameters: ConnectorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as "list" | "run";

      if (action === "list") {
        const connectorId = readStringParam(params, "connectorId");

        if (connectorId) {
          // List operations for a specific connector
          const connectors = listConnectors();
          const connector = connectors.find((c) => c.id === connectorId);
          if (!connector) {
            return jsonResult({
              status: "error",
              error: `Connector "${connectorId}" not found.`,
              available: connectors.map((c) => c.id),
            });
          }
          return jsonResult({
            status: "ok",
            connector_id: connector.id,
            name: connector.name,
            description: connector.description,
            auth_type: connector.authType,
            operations: connector.operations.map((op) => ({
              name: op.name,
              description: op.description,
              params: op.params,
            })),
          });
        }

        // List all connectors
        const all = listConnectors();
        return jsonResult({
          status: "ok",
          total: all.length,
          connectors: all.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            auth_type: c.authType,
            operations: c.operations.map((op) => op.name),
          })),
        });
      }

      if (action === "run") {
        const connectorId = readStringParam(params, "connectorId", { required: true });
        const operation = readStringParam(params, "operation", { required: true });
        const opParams =
          params.params && typeof params.params === "object" && !Array.isArray(params.params)
            ? (params.params as Record<string, unknown>)
            : {};
        const authRaw =
          params.auth && typeof params.auth === "object" && !Array.isArray(params.auth)
            ? (params.auth as Record<string, unknown>)
            : {};

        const auth = {
          apiKey: typeof authRaw.apiKey === "string" ? authRaw.apiKey : undefined,
          token: typeof authRaw.token === "string" ? authRaw.token : undefined,
          username: typeof authRaw.username === "string" ? authRaw.username : undefined,
          password: typeof authRaw.password === "string" ? authRaw.password : undefined,
        };

        const result = await runConnectorOperation(connectorId, operation, opParams, auth);

        return jsonResult({
          status: result.status,
          connector_id: result.connectorId,
          operation: result.operation,
          data: result.data,
          error: result.error,
        });
      }

      return jsonResult({ status: "error", error: "Unknown action." });
    },
  };
}
