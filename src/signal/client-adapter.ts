/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the appropriate implementation
 * based on the configured API mode. Mode resolution happens internally — callers
 * never need to know or pass apiMode.
 */

import { loadConfig } from "../config/config.js";
import {
  containerCheck,
  containerFetchAttachment,
  containerRemoveReaction,
  containerSendMessage,
  containerSendReaction,
  containerSendReceipt,
  containerSendTyping,
  streamContainerEvents,
} from "./client-container.js";
import type { SignalRpcOptions } from "./client.js";
import { signalCheck, signalRpcRequest, streamSignalEvents } from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MODE_CACHE_TTL_MS = 30_000;

export type SignalAdapterEvent = {
  event?: string;
  data?: string;
};

// Cache auto-detected modes per baseUrl to avoid repeated network probes.
const detectedModeCache = new Map<string, { mode: "native" | "container"; expiresAt: number }>();

/**
 * Resolve the effective API mode for a given baseUrl + accountId.
 * Reads config internally; callers never need to pass apiMode.
 */
async function resolveApiMode(
  baseUrl: string,
  _accountId?: string,
): Promise<"native" | "container"> {
  const cfg = loadConfig();
  // apiMode is channel-global and should not vary by account.
  const configured = cfg.channels?.signal?.apiMode ?? "auto";

  if (configured === "native" || configured === "container") {
    return configured;
  }

  // "auto" — check cache first, then probe
  const cached = detectedModeCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.mode;
  }
  const detected = await detectSignalApiMode(baseUrl);
  detectedModeCache.set(baseUrl, { mode: detected, expiresAt: Date.now() + MODE_CACHE_TTL_MS });
  return detected;
}

/**
 * Strip the `uuid:` prefix that signal-cli JSON-RPC accepts but the
 * bbernhard container REST API does not.
 */
function stripUuidPrefix(recipient: string): string {
  return recipient.startsWith("uuid:") ? recipient.slice(5) : recipient;
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
 * Drop-in replacement for signalRpcRequest that routes to the correct
 * backend (native JSON-RPC or container REST) based on config.
 * Native mode is a direct passthrough; container mode translates
 * the RPC method + params into the equivalent container API call.
 */
export async function adapterRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions & { accountId?: string },
): Promise<T> {
  const mode = await resolveApiMode(opts.baseUrl, opts.accountId);

  if (mode === "native") {
    return signalRpcRequest<T>(method, params, opts);
  }

  return handleContainerRpc<T>(method, params ?? {}, opts);
}

async function handleContainerRpc<T>(
  method: string,
  params: Record<string, unknown>,
  opts: SignalRpcOptions,
): Promise<T> {
  switch (method) {
    case "send": {
      const recipients = (params.recipient as string[] | undefined) ?? [];
      const usernames = (params.username as string[] | undefined) ?? [];
      const groupId = params.groupId as string | undefined;
      const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : undefined;
      const finalRecipients =
        recipients.length > 0
          ? recipients.map(stripUuidPrefix)
          : usernames.length > 0
            ? usernames
            : formattedGroupId
              ? [formattedGroupId]
              : [];

      // Convert text-style from native format to container format
      const textStylesRaw = params["text-style"] as string[] | undefined;
      const textStyles = textStylesRaw?.map((s) => {
        const [start, length, style] = s.split(":");
        return { start: Number(start), length: Number(length), style };
      });

      const result = await containerSendMessage({
        baseUrl: opts.baseUrl,
        account: (params.account as string) ?? "",
        recipients: finalRecipients,
        message: (params.message as string) ?? "",
        textStyles,
        attachments: params.attachments as string[] | undefined,
        timeoutMs: opts.timeoutMs,
      });
      return result as T;
    }

    case "sendTyping": {
      const recipient = stripUuidPrefix(
        (params.recipient as string[] | undefined)?.[0] ??
          (params.groupId as string | undefined) ??
          "",
      );
      await containerSendTyping({
        baseUrl: opts.baseUrl,
        account: (params.account as string) ?? "",
        recipient,
        stop: params.stop as boolean | undefined,
        timeoutMs: opts.timeoutMs,
      });
      return undefined as T;
    }

    case "sendReceipt": {
      const recipient = stripUuidPrefix((params.recipient as string[] | undefined)?.[0] ?? "");
      await containerSendReceipt({
        baseUrl: opts.baseUrl,
        account: (params.account as string) ?? "",
        recipient,
        timestamp: params.targetTimestamp as number,
        type: params.type as "read" | "viewed" | undefined,
        timeoutMs: opts.timeoutMs,
      });
      return undefined as T;
    }

    case "sendReaction": {
      const recipient = stripUuidPrefix((params.recipients as string[] | undefined)?.[0] ?? "");
      const groupId = (params.groupIds as string[] | undefined)?.[0] ?? undefined;
      const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : undefined;
      const reactionParams = {
        baseUrl: opts.baseUrl,
        account: (params.account as string) ?? "",
        recipient,
        emoji: (params.emoji as string) ?? "",
        targetAuthor: (params.targetAuthor as string) ?? recipient,
        targetTimestamp: params.targetTimestamp as number,
        groupId: formattedGroupId,
        timeoutMs: opts.timeoutMs,
      };
      const fn = params.remove ? containerRemoveReaction : containerSendReaction;
      return (await fn(reactionParams)) as T;
    }

    case "getAttachment": {
      const attachmentId = params.id as string;
      const buffer = await containerFetchAttachment(attachmentId, {
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
      });
      // Native returns { data: base64String }, container returns raw Buffer.
      // Convert to native format for callers that expect { data: base64 }.
      if (!buffer) {
        return { data: undefined } as T;
      }
      return { data: buffer.toString("base64") } as T;
    }

    default:
      throw new Error(`Unsupported container RPC method: ${method}`);
  }
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
 * Stream events from Signal, using the appropriate transport based on API mode.
 * Adapter emits the legacy SSE-like shape so callers can remain unchanged.
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
      onEvent: (event) => params.onEvent({ event: "receive", data: JSON.stringify(event) }),
      logger: params.logger,
    });
  }

  // Native SSE already uses this shape.
  return streamSignalEvents({
    baseUrl: params.baseUrl,
    account: params.account,
    abortSignal: params.abortSignal,
    onEvent: (event) => params.onEvent(event),
  });
}

/**
 * Backward-compatible wrappers used by existing tests and transitional callers.
 * New call sites should use adapterRpcRequest directly.
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

  const result = await adapterRpcRequest<{ timestamp?: number }>("send", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  return result ?? {};
}

export async function sendTypingAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  groupId?: string;
  stop?: boolean;
  timeoutMs?: number;
}): Promise<boolean> {
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
  await adapterRpcRequest("sendTyping", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  return true;
}

export async function sendReceiptAdapter(params: {
  baseUrl: string;
  account: string;
  accountId?: string;
  recipient: string;
  targetTimestamp: number;
  type?: "read" | "viewed";
  timeoutMs?: number;
}): Promise<boolean> {
  await adapterRpcRequest(
    "sendReceipt",
    {
      account: params.account,
      recipient: [params.recipient],
      targetTimestamp: params.targetTimestamp,
      type: params.type ?? "read",
    },
    {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      accountId: params.accountId,
    },
  );
  return true;
}

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
  const result = await adapterRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    accountId: params.accountId,
  });
  if (!result?.data) {
    return null;
  }
  return Buffer.from(result.data, "base64");
}

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
  const result = await adapterRpcRequest<{ timestamp?: number }>(
    "sendReaction",
    {
      emoji: params.emoji,
      targetTimestamp: params.targetTimestamp,
      targetAuthor: params.targetAuthor,
      account: params.account,
      recipients: [params.recipient],
      ...(params.groupId ? { groupIds: [params.groupId] } : {}),
    },
    {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      accountId: params.accountId,
    },
  );
  return result ?? {};
}

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
  const result = await adapterRpcRequest<{ timestamp?: number }>(
    "sendReaction",
    {
      emoji: params.emoji,
      targetTimestamp: params.targetTimestamp,
      targetAuthor: params.targetAuthor,
      account: params.account,
      remove: true,
      recipients: [params.recipient],
      ...(params.groupId ? { groupIds: [params.groupId] } : {}),
    },
    {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      accountId: params.accountId,
    },
  );
  return result ?? {};
}

/**
 * Check Signal API availability.
 * Mode resolution is internal to adapter.
 */
export async function checkAdapter(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const mode = await resolveApiMode(baseUrl);
  if (mode === "container") {
    return containerCheck(baseUrl, timeoutMs);
  }
  return signalCheck(baseUrl, timeoutMs);
}
