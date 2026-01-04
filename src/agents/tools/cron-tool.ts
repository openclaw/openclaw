import { Type } from "@sinclair/typebox";

import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const CronToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("list"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    includeDisabled: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("add"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    job: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("update"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
    patch: Type.Object({}, { additionalProperties: true }),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("run"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("runs"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    jobId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("wake"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    text: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    ),
  }),
]);

export function createCronTool(): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description:
      "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(
            await callGatewayTool("cron.status", gatewayOpts, {}),
          );
        case "list":
          return jsonResult(
            await callGatewayTool("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        case "add": {
          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          return jsonResult(
            await callGatewayTool("cron.add", gatewayOpts, params.job),
          );
        }
        case "update": {
          const jobId = readStringParam(params, "jobId", { required: true });
          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          return jsonResult(
            await callGatewayTool("cron.update", gatewayOpts, {
              jobId,
              patch: params.patch,
            }),
          );
        }
        case "remove": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.remove", gatewayOpts, { jobId }),
          );
        }
        case "run": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.run", gatewayOpts, { jobId }),
          );
        }
        case "runs": {
          const jobId = readStringParam(params, "jobId", { required: true });
          return jsonResult(
            await callGatewayTool("cron.runs", gatewayOpts, { jobId }),
          );
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGatewayTool(
              "wake",
              gatewayOpts,
              { mode, text },
              { expectFinal: false },
            ),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
