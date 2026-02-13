/**
 * Conductor Agent Tool
 *
 * Allows an AI agent to explicitly request external access through the
 * conductor's authorization system. This is the tool-call equivalent of
 * what the terminal interceptor detects implicitly.
 *
 * When an agent uses this tool, it sends a structured request to the
 * operator via messaging and waits for authorization before proceeding.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { stringEnum } from "../schema/typebox.js";

const ACCESS_KINDS = [
  "url-visit",
  "credential-fetch",
  "api-check",
  "service-action",
  "file-download",
  "verification",
] as const;

const ConductorToolSchema = Type.Object({
  action: stringEnum(["request", "status", "history"]),
  kind: Type.Optional(stringEnum([...ACCESS_KINDS])),
  summary: Type.Optional(Type.String({ description: "What you need and why." })),
  url: Type.Optional(Type.String({ description: "Target URL to access." })),
  service: Type.Optional(Type.String({ description: "Target service name." })),
  dataNeeded: Type.Optional(
    Type.String({ description: "Specific data you need from the external resource." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Authorization timeout in ms. Default: 120000." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Number of history entries to return." }),
  ),
});

export function createConductorTool(options?: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const cfg = options?.config ?? loadConfig();
  const conductorCfg = cfg.conductor;

  // Only expose the tool if conductor is configured
  if (!conductorCfg?.enabled) {
    return null;
  }

  return {
    label: "Conductor",
    name: "conductor",
    description: [
      "Request external access via the Aether Conductor.",
      "The conductor routes your request to the operator for authorization.",
      "On approval, Aether performs the browser action and returns the result.",
      'Use action="request" with summary + url/service to request access.',
      'Use action="status" to check pending requests.',
      'Use action="history" to see past authorizations.',
    ].join(" "),
    parameters: ConductorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "request": {
          const summary = readStringParam(params, "summary");
          const url = readStringParam(params, "url");
          const kind = readStringParam(params, "kind");
          const service = readStringParam(params, "service");
          const dataNeeded = readStringParam(params, "dataNeeded");
          const timeoutMs = readNumberParam(params, "timeoutMs");

          if (!summary && !url) {
            throw new Error("Provide at least a summary or url for the request.");
          }

          const result = await callGatewayTool("conductor.request", {}, {
            kind: kind ?? "unknown",
            summary: summary ?? `Access ${url}`,
            url,
            service,
            dataNeeded,
            timeoutMs,
          });

          return jsonResult(result);
        }

        case "status": {
          const result = await callGatewayTool("conductor.status", {}, {});
          return jsonResult(result);
        }

        case "history": {
          const limit = readNumberParam(params, "limit");
          const result = await callGatewayTool("conductor.history", {}, {
            limit: limit ?? 20,
          });
          return jsonResult(result);
        }

        default:
          throw new Error(`Unknown conductor action: ${action}`);
      }
    },
  };
}
