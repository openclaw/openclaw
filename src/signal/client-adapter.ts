/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the appropriate implementation
 * based on the configured API mode. Exports mirror client.ts names so consumers
 * only need to change their import path.
 */

import { loadConfig } from "../config/config.js";
import {
  containerCheck,
  containerRpcRequest,
  streamContainerEvents,
  containerFetchAttachment,
} from "./client-container.js";
import type { SignalRpcOptions } from "./client.js";
import {
  signalCheck as nativeCheck,
  signalRpcRequest as nativeRpcRequest,
  streamSignalEvents as nativeStreamEvents,
} from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MODE_CACHE_TTL_MS = 30_000;

export type SignalAdapterEvent = {
  event?: string;
  data?: string;
};

// Re-export the options type so consumers can import it from the adapter.
export type { SignalRpcOptions } from "./client.js";

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
 * Detect which Signal API mode is available by probing endpoints.
 * First endpoint to respond OK wins.
 */
export async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<"native" | "container"> {
  const nativePromise = nativeCheck(baseUrl, timeoutMs).then((r) =>
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
 * Drop-in replacement for native signalRpcRequest.
 * Routes to native JSON-RPC or container REST based on config.
 */
export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions & { accountId?: string },
): Promise<T> {
  const mode = await resolveApiMode(opts.baseUrl, opts.accountId);
  if (mode === "native") {
    return nativeRpcRequest<T>(method, params, opts);
  }
  return containerRpcRequest<T>(method, params, opts);
}

/**
 * Drop-in replacement for native signalCheck.
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const mode = await resolveApiMode(baseUrl);
  if (mode === "container") {
    return containerCheck(baseUrl, timeoutMs);
  }
  return nativeCheck(baseUrl, timeoutMs);
}

/**
 * Drop-in replacement for native streamSignalEvents.
 * Container mode uses WebSocket; native uses SSE.
 */
export async function streamSignalEvents(params: {
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

  return nativeStreamEvents({
    baseUrl: params.baseUrl,
    account: params.account,
    abortSignal: params.abortSignal,
    onEvent: (event) => params.onEvent(event),
  });
}

/**
 * Fetch attachment, routing to native or container implementation.
 */
export async function fetchAttachment(params: {
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
  const result = await nativeRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });
  if (!result?.data) {
    return null;
  }
  return Buffer.from(result.data, "base64");
}
