/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the appropriate implementation
 * based on the configured API mode. Mode resolution happens internally — callers
 * never need to know or pass apiMode.
 */

import type { SignalApiMode } from "../config/types.signal.js";
import type { ContainerWebSocketMessage } from "./client-container.js";
import type { SignalSseEvent } from "./client.js";
import { loadConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import {
  containerCheck,
  containerFetchAttachment,
  containerSendMessage,
  containerSendReceipt,
  containerSendTyping,
  streamContainerEvents,
} from "./client-container.js";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;

// Cache auto-detected modes per baseUrl to avoid repeated network probes.
const detectedModeCache = new Map<string, "native" | "container">();

/**
 * Resolve the effective API mode for a given baseUrl + accountId.
 * Reads config internally; callers never need to pass apiMode.
 */
async function resolveApiMode(
  baseUrl: string,
  accountId?: string,
): Promise<"native" | "container"> {
  const cfg = loadConfig();
  const account = resolveSignalAccount({ cfg, accountId });
  const configured = account.config.apiMode ?? "auto";

  if (configured === "native" || configured === "container") {
    return configured;
  }

  // "auto" — check cache first, then probe
  const cached = detectedModeCache.get(baseUrl);
  if (cached) {
    return cached;
  }
  const detected = await detectSignalApiMode(baseUrl);
  detectedModeCache.set(baseUrl, detected);
  return detected;
}

/**
 * Convert a group internal_id to the container-expected format.
 * The bbernhard container expects groups in the form: "group.{base64(internal_id)}"
 * But incoming messages provide just the internal_id.
 */
function formatGroupIdForContainer(groupId: string): string {
  // Already in correct format
  if (groupId.startsWith("group.")) {
    return groupId;
  }
  // Convert internal_id to group.{base64(internal_id)}
  const encoded = Buffer.from(groupId).toString("base64");
  return `group.${encoded}`;
}

/**
 * Detect which Signal API mode is available by probing endpoints.
 * First endpoint to respond OK wins.
 */
export async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<"native" | "container"> {
  // Race both endpoints - first to respond OK wins
  const nativePromise = signalCheck(baseUrl, timeoutMs).then((r) =>
    r.ok ? ("native" as const) : Promise.reject(new Error("native not ok")),
  );
  const containerPromise = containerCheck(baseUrl, timeoutMs).then((r) =>
    r.ok ? ("container" as const) : Promise.reject(new Error("container not ok")),
  );

  try {
    return await Promise.any([nativePromise, containerPromise]);
  } catch {
    throw new Error(`Signal API not reachable at ${baseUrl}`);
  }
}

/**
 * Unified event type - either SSE event or WebSocket message.
 */
export type SignalAdapterEvent = SignalSseEvent | ContainerWebSocketMessage;

/**
 * Stream events from Signal, using the appropriate transport based on API mode.
 */
export async function streamSignalEventsAdapter(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalAdapterEvent) => void;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    return streamContainerEvents({
      baseUrl: params.baseUrl,
      account: params.account,
      abortSignal: params.abortSignal,
      onEvent: (event) => params.onEvent(event),
      logger: params.logger,
    });
  }

  // Default: native signal-cli SSE
  return streamSignalEvents({
    baseUrl: params.baseUrl,
    account: params.account,
    abortSignal: params.abortSignal,
    onEvent: (event) => params.onEvent(event),
  });
}

/**
 * Send a message via Signal, using the appropriate API based on mode.
 */
export async function sendMessageAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipients: string[];
  groupId?: string;
  message: string;
  textStyles?: Array<{ start: number; length: number; style: string }>;
  attachments?: string[];
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    // For container mode, group IDs must be in format "group.{base64(internal_id)}"
    const formattedGroupId = params.groupId ? formatGroupIdForContainer(params.groupId) : undefined;
    const recipients =
      params.recipients.length > 0 ? params.recipients : formattedGroupId ? [formattedGroupId] : [];

    return containerSendMessage({
      baseUrl: params.baseUrl,
      account: params.account,
      recipients,
      message: params.message,
      textStyles: params.textStyles,
      attachments: params.attachments,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC
  const rpcParams: Record<string, unknown> = {
    message: params.message,
    account: params.account,
  };

  if (params.recipients.length > 0) {
    rpcParams.recipient = params.recipients;
  } else if (params.groupId) {
    rpcParams.groupId = params.groupId;
  }

  if (params.textStyles && params.textStyles.length > 0) {
    rpcParams["text-style"] = params.textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }

  if (params.attachments && params.attachments.length > 0) {
    rpcParams.attachments = params.attachments;
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("send", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  return result ?? {};
}

/**
 * Send typing indicator via Signal.
 */
export async function sendTypingAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  groupId?: string;
  stop?: boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    return containerSendTyping({
      baseUrl: params.baseUrl,
      account: params.account,
      recipient: params.recipient,
      stop: params.stop,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC
  const rpcParams: Record<string, unknown> = {
    account: params.account,
  };

  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else {
    rpcParams.recipient = [params.recipient];
  }

  if (params.stop) {
    rpcParams.stop = true;
  }

  await signalRpcRequest("sendTyping", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  return true;
}

/**
 * Send read receipt via Signal.
 */
export async function sendReceiptAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  targetTimestamp: number;
  type?: "read" | "viewed";
  timeoutMs?: number;
}): Promise<boolean> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    return containerSendReceipt({
      baseUrl: params.baseUrl,
      account: params.account,
      recipient: params.recipient,
      timestamp: params.targetTimestamp,
      type: params.type,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC
  const rpcParams: Record<string, unknown> = {
    account: params.account,
    recipient: [params.recipient],
    targetTimestamp: params.targetTimestamp,
    type: params.type ?? "read",
  };

  await signalRpcRequest("sendReceipt", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  return true;
}

/**
 * Fetch attachment from Signal.
 */
export async function fetchAttachmentAdapter(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  attachmentId: string;
  sender?: string;
  groupId?: string;
  timeoutMs?: number;
}): Promise<Buffer | null> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    return containerFetchAttachment(params.attachmentId, {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC
  const rpcParams: Record<string, unknown> = {
    id: params.attachmentId,
  };

  if (params.account) {
    rpcParams.account = params.account;
  }

  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else if (params.sender) {
    rpcParams.recipient = params.sender;
  } else {
    return null;
  }

  const result = await signalRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  if (!result?.data) {
    return null;
  }

  return Buffer.from(result.data, "base64");
}

/**
 * Check Signal API availability.
 * Accepts optional apiMode for diagnostic tools (e.g. probe);
 * if omitted, resolves from config.
 */
export async function checkAdapter(
  baseUrl: string,
  apiMode?: SignalApiMode,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  accountId?: string,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const mode = apiMode && apiMode !== "auto" ? apiMode : await resolveApiMode(baseUrl, accountId);
  if (mode === "container") {
    return containerCheck(baseUrl, timeoutMs);
  }
  return signalCheck(baseUrl, timeoutMs);
}

/**
 * Send a reaction to a message via Signal.
 */
export async function sendReactionAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    const { containerSendReaction } = await import("./client-container.js");
    return containerSendReaction({
      baseUrl: params.baseUrl,
      account: params.account,
      recipient: params.recipient,
      emoji: params.emoji,
      targetAuthor: params.targetAuthor,
      targetTimestamp: params.targetTimestamp,
      groupId: params.groupId,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC
  const rpcParams: Record<string, unknown> = {
    emoji: params.emoji,
    targetTimestamp: params.targetTimestamp,
    targetAuthor: params.targetAuthor,
    account: params.account,
  };

  if (params.recipient) {
    rpcParams.recipients = [params.recipient];
  }

  if (params.groupId) {
    rpcParams.groupIds = [params.groupId];
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  return result ?? {};
}

/**
 * Remove a reaction from a message via Signal.
 */
export async function removeReactionAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const mode = await resolveApiMode(params.baseUrl, params.accountId);

  if (mode === "container") {
    const { containerRemoveReaction } = await import("./client-container.js");
    return containerRemoveReaction({
      baseUrl: params.baseUrl,
      account: params.account,
      recipient: params.recipient,
      emoji: params.emoji,
      targetAuthor: params.targetAuthor,
      targetTimestamp: params.targetTimestamp,
      groupId: params.groupId,
      timeoutMs: params.timeoutMs,
    });
  }

  // Default: native JSON-RPC with remove flag
  const rpcParams: Record<string, unknown> = {
    emoji: params.emoji,
    targetTimestamp: params.targetTimestamp,
    targetAuthor: params.targetAuthor,
    account: params.account,
    remove: true,
  };

  if (params.recipient) {
    rpcParams.recipients = [params.recipient];
  }

  if (params.groupId) {
    rpcParams.groupIds = [params.groupId];
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  return result ?? {};
}
