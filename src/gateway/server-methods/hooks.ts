// Gateway RPC handlers for webhook queue visibility.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  listHookQueueItems,
  summarizeHookQueueItems,
  type HookQueueItem,
  type HookQueueItemStatus,
} from "../hook-queue-store.js";
import { resolveHooksConfig } from "../hooks.js";
import type { GatewayRequestHandlers } from "./types.js";

const HOOK_QUEUE_STATUSES = new Set<HookQueueItemStatus>(["queued", "running", "ok", "error"]);

function normalizeQueueItemStatuses(raw: unknown): HookQueueItemStatus[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const statuses = raw.filter((entry): entry is HookQueueItemStatus => {
    return typeof entry === "string" && HOOK_QUEUE_STATUSES.has(entry as HookQueueItemStatus);
  });
  return statuses.length > 0 ? statuses : undefined;
}

function compactHookQueueItem(item: HookQueueItem) {
  return {
    itemId: item.itemId,
    queueId: item.queueId,
    status: item.status,
    runId: item.runId,
    sourcePath: item.sourcePath,
    name: item.name,
    message: item.payload.message,
    messagePreview: item.messagePreview,
    agentId: item.agentId ?? null,
    sessionKey: item.sessionKey,
    sessionTarget: item.sessionTarget,
    model: item.payload.model ?? null,
    thinking: item.payload.thinking ?? null,
    timeoutSeconds: item.payload.timeoutSeconds ?? null,
    createdAtMs: item.createdAtMs,
    claimedAtMs: item.claimedAtMs ?? null,
    startedAtMs: item.startedAtMs ?? null,
    finishedAtMs: item.finishedAtMs ?? null,
    updatedAtMs: item.updatedAtMs,
    error: item.error ?? null,
    summary: item.summary ?? null,
  };
}

function readQueueIdParam(params: Record<string, unknown>, method: string) {
  const queueId = typeof params.queueId === "string" ? params.queueId.trim() : undefined;
  if (!queueId) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: empty queueId`),
    };
  }
  return { ok: true as const, queueId };
}

function findConfiguredQueue(
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  queueId: string,
) {
  const hooksConfig = resolveHooksConfig(context.getRuntimeConfig());
  return hooksConfig?.queues.find((queue) => queue.id === queueId) ?? null;
}

function setQueuePausedHandler(paused: boolean): GatewayRequestHandlers[string] {
  const method = paused ? "hooks.queue.pause" : "hooks.queue.resume";
  return ({ params, respond, context }) => {
    const parsed = readQueueIdParam(params, method);
    if (!parsed.ok) {
      respond(false, undefined, parsed.error);
      return;
    }
    const queue = findConfiguredQueue(context, parsed.queueId);
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `hook queue not found: ${parsed.queueId}`),
      );
      return;
    }
    const result = context.hookQueueRuntime.setQueuePaused(queue.id, paused);
    respond(true, result);
  };
}

export const hooksHandlers: GatewayRequestHandlers = {
  "hooks.queues": ({ respond, context }) => {
    const hooksConfig = resolveHooksConfig(context.getRuntimeConfig());
    if (!hooksConfig) {
      respond(true, { queues: [] });
      return;
    }
    const snapshots = new Map(
      summarizeHookQueueItems(hooksConfig.queues.map((queue) => queue.id)).map((snapshot) => [
        snapshot.queueId,
        snapshot,
      ]),
    );
    respond(true, {
      queues: hooksConfig.queues.map((queue) => {
        const snapshot = snapshots.get(queue.id);
        return {
          id: queue.id,
          path: `${hooksConfig.basePath}/${queue.path}`,
          parallelism: queue.parallelism,
          sessionTarget: queue.sessionTarget,
          agentId: queue.agentId ?? null,
          paused: snapshot?.paused ?? false,
          pausedAtMs: snapshot?.pausedAtMs ?? null,
          stateUpdatedAtMs: snapshot?.stateUpdatedAtMs ?? null,
          counts: snapshot?.counts ?? { queued: 0, running: 0, ok: 0, error: 0 },
          oldestQueuedAtMs: snapshot?.oldestQueuedAtMs ?? null,
          newestQueuedAtMs: snapshot?.newestQueuedAtMs ?? null,
        };
      }),
    });
  },
  "hooks.queue.items": ({ params, respond }) => {
    const queueId = typeof params.queueId === "string" ? params.queueId.trim() : undefined;
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const offset = typeof params.offset === "number" ? params.offset : undefined;
    if (queueId !== undefined && queueId.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid hooks.queue.items params: empty queueId"),
      );
      return;
    }
    const result = listHookQueueItems({
      queueId,
      statuses: normalizeQueueItemStatuses(params.statuses),
      limit,
      offset,
    });
    respond(true, {
      ...result,
      items: result.items.map(compactHookQueueItem),
    });
  },
  "hooks.queue.pause": setQueuePausedHandler(true),
  "hooks.queue.resume": setQueuePausedHandler(false),
};
