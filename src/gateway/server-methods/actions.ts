import {
  addActionQueueItem,
  listActionQueueItems,
  updateActionQueueItem,
  type ActionQueueAddInput,
  type ActionQueueListInput,
  type ActionQueueUpdateInput,
} from "../../actions/action-queue.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function invalid(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"], err: unknown) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      err instanceof Error ? err.message : "invalid actions request",
    ),
  );
}

export const actionsHandlers: GatewayRequestHandlers = {
  "actions.list": async ({ params, respond }) => {
    try {
      const result = await listActionQueueItems(params as ActionQueueListInput);
      respond(true, result, undefined);
    } catch (err) {
      invalid(respond, err);
    }
  },

  "actions.add": async ({ params, respond }) => {
    try {
      const item = await addActionQueueItem(params as unknown as ActionQueueAddInput);
      respond(true, { item }, undefined);
    } catch (err) {
      invalid(respond, err);
    }
  },

  "actions.update": async ({ params, respond }) => {
    try {
      const p = params as { id?: unknown; patch?: unknown };
      if (typeof p.id !== "string" || !p.id.trim()) {
        throw new Error("id is required");
      }
      if (typeof p.patch !== "object" || p.patch == null || Array.isArray(p.patch)) {
        throw new Error("patch must be an object");
      }
      const item = await updateActionQueueItem({
        id: p.id,
        patch: p.patch as ActionQueueUpdateInput["patch"],
      });
      respond(true, { item }, undefined);
    } catch (err) {
      invalid(respond, err);
    }
  },

  "actions.resolve": async ({ params, respond }) => {
    try {
      const p = params as { id?: unknown; status?: unknown };
      if (typeof p.id !== "string" || !p.id.trim()) {
        throw new Error("id is required");
      }
      const status = p.status === "dismissed" ? "dismissed" : "done";
      const item = await updateActionQueueItem({
        id: p.id,
        patch: { status },
      });
      respond(true, { item }, undefined);
    } catch (err) {
      invalid(respond, err);
    }
  },
};
