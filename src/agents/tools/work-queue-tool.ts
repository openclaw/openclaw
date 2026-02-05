import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { WorkItemPriority } from "../../work-queue/types.js";
import { getDefaultWorkQueueStore } from "../../work-queue/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const WORK_QUEUE_ACTIONS = ["status", "create", "list", "get", "update", "stats"] as const;

const WORK_QUEUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;

const WorkQueueToolSchema = Type.Object({
  action: stringEnum(WORK_QUEUE_ACTIONS),
  queueId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  concurrencyLimit: Type.Optional(Type.Number({ minimum: 1 })),
  defaultPriority: Type.Optional(stringEnum(WORK_QUEUE_PRIORITIES)),
});

type WorkQueueToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
};

function resolveAgentId(options: WorkQueueToolOptions, agentId?: string) {
  const raw = agentId?.trim();
  if (raw) {
    return raw;
  }
  return resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: options.config });
}

export function createWorkQueueTool(options: WorkQueueToolOptions = {}): AnyAgentTool {
  return {
    name: "work_queue",
    label: "Work Queue",
    description: `Manage work queues for agent task coordination.

Actions:
- status: Get queue status and stats for current or specified agent
- create: Create a new queue
- list: List all queues or filter by agent
- get: Get a specific queue by ID
- update: Update queue settings (concurrencyLimit, defaultPriority)
- stats: Get detailed statistics for a queue`,
    schema: WorkQueueToolSchema,
    async execute(params) {
      const action = readStringParam(params, "action", { required: true });
      const store = await getDefaultWorkQueueStore();
      const queueId = readStringParam(params, "queueId");
      const agentId = resolveAgentId(options, readStringParam(params, "agentId"));
      const concurrencyLimit = readNumberParam(params, "concurrencyLimit", { integer: true });
      const defaultPriority = readStringParam(params, "defaultPriority") as
        | WorkItemPriority
        | undefined;
      const name = readStringParam(params, "name");

      switch (action) {
        case "status": {
          const queue = queueId
            ? await store.getQueue(queueId)
            : await store.getQueueByAgentId(agentId);
          if (!queue) {
            return jsonResult({ queue: null, stats: null });
          }
          const stats = await store.getQueueStats(queue.id);
          return jsonResult({ queue, stats });
        }
        case "create": {
          const targetAgentId = agentId ?? resolveAgentId(options);
          if (!targetAgentId) {
            throw new Error("agentId required to create a queue");
          }
          const created = await store.ensureQueueForAgent(targetAgentId, name);
          const updated = await store.updateQueue(created.id, {
            ...(concurrencyLimit ? { concurrencyLimit } : {}),
            ...(defaultPriority ? { defaultPriority } : {}),
          });
          return jsonResult({ queue: updated });
        }
        case "list": {
          const queues = await store.listQueues({ agentId: agentId || undefined });
          return jsonResult({ queues });
        }
        case "get": {
          if (!queueId) {
            throw new Error("queueId required");
          }
          const queue = await store.getQueue(queueId);
          return jsonResult({ queue });
        }
        case "update": {
          if (!queueId) {
            throw new Error("queueId required");
          }
          const updated = await store.updateQueue(queueId, {
            ...(name ? { name } : {}),
            ...(concurrencyLimit ? { concurrencyLimit } : {}),
            ...(defaultPriority ? { defaultPriority } : {}),
          });
          return jsonResult({ queue: updated });
        }
        case "stats": {
          const targetQueueId = queueId ? queueId : (await store.getQueueByAgentId(agentId))?.id;
          if (!targetQueueId) {
            return jsonResult({ stats: null });
          }
          const stats = await store.getQueueStats(targetQueueId);
          return jsonResult({ stats });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
