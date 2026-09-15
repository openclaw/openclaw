import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

export function resolveSessionCreateInitialTurn(params: {
  attachments?: unknown[];
  message?: unknown;
  task?: unknown;
}) {
  const message = resolveOptionalInitialSessionMessage(params);
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.attachments as RpcAttachmentInput[] | undefined,
  );
  if (params.attachments?.length && !message && normalizedAttachments.length === 0) {
    return null;
  }
  const attachments = normalizedAttachments.length ? normalizedAttachments : undefined;
  return {
    attachments,
    hasInitialTurn: message !== undefined || attachments !== undefined,
    message,
  };
}

export function isFreshChatSendStarted(params: { cached?: boolean; payload: unknown }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

export function resolveSessionCreateResponseState(params: {
  entry: InternalSessionEntry;
  resetExisting: boolean;
  payload: unknown;
  cached?: boolean;
}) {
  return {
    responseEntry: sessionEntryForkedFromParent(params.entry)
      ? { ...params.entry, forkedFromParent: true as const }
      : params.entry,
    runStarted:
      !params.resetExisting &&
      isFreshChatSendStarted({ payload: params.payload, cached: params.cached }),
  };
}
