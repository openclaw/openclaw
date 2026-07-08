// hook_queue built-in tool.
//
// Exposes configured webhook queue inspection and pause/resume controls without
// handing the model the broader generic Gateway RPC surface.
import { Type, type TSchema } from "typebox";
import { optionalNonNegativeIntegerSchema, stringEnum } from "../schema/typebox.js";
import { HOOK_QUEUE_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const HOOK_QUEUE_ACTIONS = ["list", "items", "pause", "resume"] as const;
const HOOK_QUEUE_STATUSES = ["queued", "running", "ok", "error"] as const;

type GatewayToolCaller = typeof callGatewayTool;

type HookQueueToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

export function createHookQueueToolSchema(): TSchema {
  return Type.Object(
    {
      action: stringEnum(HOOK_QUEUE_ACTIONS),
      ...gatewayCallOptionSchemaProperties(),
      queueId: Type.Optional(Type.String({ description: "Queue id for items/pause/resume" })),
      statuses: Type.Optional(
        Type.Array(stringEnum(HOOK_QUEUE_STATUSES), {
          description: "Optional item status filters for action=items",
        }),
      ),
      limit: optionalNonNegativeIntegerSchema({ description: "Maximum items for action=items" }),
      offset: optionalNonNegativeIntegerSchema({ description: "Pagination offset" }),
    },
    { additionalProperties: true },
  );
}

function readQueueId(params: Record<string, unknown>, action: string): string {
  return readStringParam(params, "queueId", {
    required: true,
    label: `queueId for action=${action}`,
  });
}

export function createHookQueueTool(_opts?: unknown, deps?: HookQueueToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  return {
    label: "Hook Queue",
    name: "hook_queue",
    displaySummary: HOOK_QUEUE_TOOL_DISPLAY_SUMMARY,
    description: `Inspect and control configured webhook queues.

ACTIONS:
- list: list queue summaries, counts, parallelism, paths, and paused state
- items: inspect queued/running/completed messages for one queue; needs queueId
- pause: stop claiming new work for one queue; running items continue; needs queueId
- resume: resume queue processing and start pending work up to configured parallelism; needs queueId`,
    parameters: createHookQueueToolSchema(),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);
      switch (action) {
        case "list":
          return jsonResult(await callGateway("hooks.queues", gatewayOpts, {}));
        case "items": {
          const statuses = readStringArrayParam(params, "statuses");
          return jsonResult(
            await callGateway("hooks.queue.items", gatewayOpts, {
              queueId: readQueueId(params, action),
              ...(statuses && statuses.length > 0 ? { statuses } : {}),
              limit: readNonNegativeIntegerParam(params, "limit", { max: 200 }),
              offset: readNonNegativeIntegerParam(params, "offset"),
            }),
          );
        }
        case "pause":
          return jsonResult(
            await callGateway("hooks.queue.pause", gatewayOpts, {
              queueId: readQueueId(params, action),
            }),
          );
        case "resume":
          return jsonResult(
            await callGateway("hooks.queue.resume", gatewayOpts, {
              queueId: readQueueId(params, action),
            }),
          );
        default:
          throw new Error(`unknown hook queue action: ${action}`);
      }
    },
  };
}
