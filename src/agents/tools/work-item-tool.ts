import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getDefaultWorkQueueStore } from "../../work-queue/index.js";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  type WorkItemPriority,
  type WorkItemStatus,
} from "../../work-queue/types.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const WORK_ITEM_ACTIONS = [
  "add",
  "claim",
  "update",
  "list",
  "get",
  "complete",
  "fail",
  "block",
  "unblock",
  "cancel",
  "reassign",
] as const;

const WorkItemToolSchema = Type.Object({
  action: stringEnum(WORK_ITEM_ACTIONS),
  itemId: Type.Optional(Type.String()),
  queueId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
  priority: optionalStringEnum(WORK_ITEM_PRIORITIES),
  parentItemId: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  tags: Type.Optional(Type.Array(Type.String())),
  status: optionalStringEnum(WORK_ITEM_STATUSES),
  statusReason: Type.Optional(Type.String()),
  result: Type.Optional(Type.Object({}, { additionalProperties: true })),
  error: Type.Optional(Type.Object({}, { additionalProperties: true })),
  statuses: Type.Optional(Type.Array(stringEnum(WORK_ITEM_STATUSES))),
  priorities: Type.Optional(Type.Array(stringEnum(WORK_ITEM_PRIORITIES))),
  assignedTo: Type.Optional(Type.String()),
  createdBy: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
  orderBy: optionalStringEnum(["createdAt", "updatedAt", "priority"] as const),
  orderDir: optionalStringEnum(["asc", "desc"] as const),
  includeCompleted: Type.Optional(Type.Boolean()),
});

type WorkItemToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
};

function resolveAgentId(options: WorkItemToolOptions, agentId?: string) {
  const raw = agentId?.trim();
  if (raw) {
    return raw;
  }
  return resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: options.config });
}

function coerceStatuses(
  statuses?: string[],
  status?: string,
  includeCompleted?: boolean,
): WorkItemStatus[] | undefined {
  if (statuses && statuses.length > 0) {
    return statuses as WorkItemStatus[];
  }
  if (status) {
    return [status as WorkItemStatus];
  }
  if (includeCompleted === false) {
    return ["pending", "in_progress", "blocked"];
  }
  return undefined;
}

export function createWorkItemTool(options: WorkItemToolOptions = {}): AnyAgentTool {
  return {
    name: "work_item",
    label: "Work Item",
    description: `Manage work items in agent queues. Items persist after completion for history.

Actions:
- add: Create a new work item in a queue
- claim: Atomically claim the next available item
- update: Update item fields (title, description, priority, tags)
- list: Query items with filters (status, priority, tags, date range)
- get: Get a single item by ID with full details
- complete: Mark item as completed with optional result
- fail: Mark item as failed with error details
- block: Mark item as blocked with reason
- unblock: Clear block, return to pending
- cancel: Cancel a pending or blocked item
- reassign: Move item to a different queue/agent`,
    schema: WorkItemToolSchema,
    async execute(params) {
      const action = readStringParam(params, "action", { required: true });
      const store = await getDefaultWorkQueueStore();
      const itemId = readStringParam(params, "itemId");
      const queueId = readStringParam(params, "queueId");
      const agentId = resolveAgentId(options, readStringParam(params, "agentId"));
      const title = readStringParam(params, "title");
      const description = readStringParam(params, "description");
      const priority = readStringParam(params, "priority") as WorkItemPriority | undefined;
      const parentItemId = readStringParam(params, "parentItemId");
      const dependsOn = readStringArrayParam(params, "dependsOn");
      const blockedBy = readStringArrayParam(params, "blockedBy");
      const tags = readStringArrayParam(params, "tags");
      const statusReason = readStringParam(params, "statusReason");
      const status = readStringParam(params, "status") as WorkItemStatus | undefined;
      const result = (params as { result?: Record<string, unknown> }).result;
      const error = (params as { error?: Record<string, unknown> }).error;
      const payload = (params as { payload?: Record<string, unknown> }).payload;

      switch (action) {
        case "add": {
          if (!title) {
            throw new Error("title required");
          }
          const createdBy = {
            sessionKey: options.agentSessionKey,
            agentId,
          };
          const item = await store.createItem({
            queueId,
            agentId,
            title,
            description,
            payload,
            priority,
            parentItemId,
            dependsOn,
            blockedBy,
            tags,
            createdBy,
            status: status ?? "pending",
            statusReason,
          });
          return jsonResult({ item });
        }
        case "claim": {
          const assignTo = { sessionKey: options.agentSessionKey, agentId };
          const claimed = await store.claimNextItem({ queueId, agentId, assignTo });
          return jsonResult({ item: claimed });
        }
        case "update": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const updated = await store.updateItem(itemId, {
            title,
            description,
            payload,
            priority,
            tags,
            status,
            statusReason,
            dependsOn,
            blockedBy,
            parentItemId,
          });
          return jsonResult({ item: updated });
        }
        case "list": {
          const statuses = readStringArrayParam(params, "statuses");
          const priorities = readStringArrayParam(params, "priorities");
          const assignedTo = readStringParam(params, "assignedTo");
          const createdBy = readStringParam(params, "createdBy");
          const includeCompleted = Boolean(params.includeCompleted);
          const limit = readNumberParam(params, "limit", { integer: true });
          const offset = readNumberParam(params, "offset", { integer: true });
          const orderBy = readStringParam(params, "orderBy") as
            | "createdAt"
            | "updatedAt"
            | "priority"
            | undefined;
          const orderDir = readStringParam(params, "orderDir") as "asc" | "desc" | undefined;
          const filteredStatuses = coerceStatuses(statuses, status, includeCompleted);
          const items = await store.listItems({
            queueId,
            status: filteredStatuses,
            priority: priorities ? (priorities as WorkItemPriority[]) : undefined,
            tags,
            assignedTo,
            createdBy,
            parentItemId,
            limit: limit ?? undefined,
            offset: offset ?? undefined,
            orderBy,
            orderDir,
          });
          return jsonResult({ items });
        }
        case "get": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const item = await store.getItem(itemId);
          return jsonResult({ item });
        }
        case "complete": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const now = new Date().toISOString();
          const updated = await store.updateItem(itemId, {
            status: "completed",
            statusReason,
            result,
            completedAt: now,
          });
          return jsonResult({ item: updated });
        }
        case "fail": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const now = new Date().toISOString();
          const updated = await store.updateItem(itemId, {
            status: "failed",
            statusReason,
            error,
            completedAt: now,
          });
          return jsonResult({ item: updated });
        }
        case "block": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const updated = await store.updateItem(itemId, {
            status: "blocked",
            statusReason,
          });
          return jsonResult({ item: updated });
        }
        case "unblock": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const updated = await store.updateItem(itemId, {
            status: "pending",
            statusReason,
          });
          return jsonResult({ item: updated });
        }
        case "cancel": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const now = new Date().toISOString();
          const updated = await store.updateItem(itemId, {
            status: "cancelled",
            statusReason,
            completedAt: now,
          });
          return jsonResult({ item: updated });
        }
        case "reassign": {
          if (!itemId) {
            throw new Error("itemId required");
          }
          const targetQueueId = queueId ?? agentId;
          if (!targetQueueId) {
            throw new Error("queueId or agentId required");
          }
          const updated = await store.updateItem(itemId, {
            queueId: targetQueueId,
          });
          return jsonResult({ item: updated });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
