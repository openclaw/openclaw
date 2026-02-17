import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveFetch } from "../infra/fetch.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
};

export type SignalRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
// Keep send timeout comfortably above receive poll/lock windows on signal-cli-rest-api.
const SIGNAL_REST_SEND_TIMEOUT_MS = 90_000;
const SIGNAL_BACKEND_DETECT_TIMEOUT_MS = 2_000;
// Balance CPU usage and reply latency; long polls can delay outbound sends on signal-cli locks.
const SIGNAL_REST_POLL_TIMEOUT_SECONDS = 10;
const SIGNAL_REST_ACCOUNT_RETRY_DELAY_MS = 5_000;
const SIGNAL_REST_ACCOUNT_HEALTH_CACHE_OK_MS = 300_000;
const SIGNAL_REST_ACCOUNT_HEALTH_CACHE_ERROR_MS = 5_000;

type SignalRestAbout = {
  versions?: unknown;
  build?: unknown;
  mode?: unknown;
  version?: unknown;
  capabilities?: unknown;
};

type SignalBackend =
  | { kind: "jsonrpc" }
  | {
      kind: "rest";
      about: SignalRestAbout | null;
    };

const signalBackendCache = new Map<string, Promise<SignalBackend>>();
type SignalRestAccountHealth = {
  ok: boolean;
  error: string | null;
};
const signalRestAccountHealthCache = new Map<
  string,
  { checkedAt: number; health: SignalRestAccountHealth }
>();
const signalRestAccountHealthInFlight = new Map<string, Promise<SignalRestAccountHealth>>();

function trimString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => trimString(entry)).filter((entry): entry is string => Boolean(entry));
}

function parseSignalRestAccountEntry(entry: unknown): string | null {
  const direct = trimString(entry);
  if (direct) {
    return direct;
  }
  const obj = asObject(entry);
  if (!obj) {
    return null;
  }
  const candidates = [obj["number"], obj["account"], obj["id"], obj["username"]];
  for (const candidate of candidates) {
    const value = trimString(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function extractTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractTimestamp(entry);
      if (typeof extracted === "number") {
        return extracted;
      }
    }
    return undefined;
  }
  const obj = asObject(value);
  if (!obj) {
    return undefined;
  }
  const direct = extractTimestamp(obj["timestamp"]);
  if (typeof direct === "number") {
    return direct;
  }
  const nestedKeys = ["results", "result", "data", "messages"];
  for (const key of nestedKeys) {
    const nested = extractTimestamp(obj[key]);
    if (typeof nested === "number") {
      return nested;
    }
  }
  return undefined;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function getRequiredFetch(): typeof fetch {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  if (name === "AbortError") {
    return true;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "ABORT_ERR";
}

async function readResponseSnippet(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).trim();
    if (!text) {
      return null;
    }
    if (text.length <= 220) {
      return text;
    }
    return `${text.slice(0, 220)}...`;
  } catch {
    return null;
  }
}

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onDone = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      onDone();
    };
    const timer = setTimeout(onDone, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchSignalRestAbout(baseUrl: string, timeoutMs: number): Promise<SignalRestAbout> {
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/about`,
    { method: "GET" },
    timeoutMs,
    getRequiredFetch(),
  );
  if (!res.ok) {
    const details = await readResponseSnippet(res);
    throw new Error(
      details
        ? `Signal REST about failed (${res.status}): ${details}`
        : `Signal REST about failed (${res.status})`,
    );
  }
  try {
    const parsed = (await res.json()) as SignalRestAbout;
    return parsed;
  } catch (err) {
    throw new Error(`Signal REST about returned invalid JSON: ${String(err)}`, { cause: err });
  }
}

async function listSignalRestAccounts(baseUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/v1/accounts`,
      { method: "GET" },
      timeoutMs,
      getRequiredFetch(),
    );
    if (!res.ok) {
      return [];
    }
    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => parseSignalRestAccountEntry(entry))
      .filter((entry): entry is string => Boolean(entry));
  } catch {
    return [];
  }
}

function getSignalRestAccountHealthCacheTtlMs(health: SignalRestAccountHealth): number {
  return health.ok
    ? SIGNAL_REST_ACCOUNT_HEALTH_CACHE_OK_MS
    : SIGNAL_REST_ACCOUNT_HEALTH_CACHE_ERROR_MS;
}

async function getSignalRestAccountHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<SignalRestAccountHealth> {
  const cached = signalRestAccountHealthCache.get(baseUrl);
  if (cached) {
    const ageMs = Date.now() - cached.checkedAt;
    if (ageMs >= 0 && ageMs < getSignalRestAccountHealthCacheTtlMs(cached.health)) {
      return cached.health;
    }
  }

  const inFlight = signalRestAccountHealthInFlight.get(baseUrl);
  if (inFlight) {
    return await inFlight;
  }

  const pending = (async () => {
    const accounts = await listSignalRestAccounts(baseUrl, timeoutMs);
    if (accounts.length === 0) {
      return {
        ok: false,
        error:
          "Signal REST is reachable, but no account is registered yet. Link a device first (for example via /v1/qrcodelink).",
      } as const;
    }
    if (accounts.length > 1) {
      return {
        ok: false,
        error: "Signal REST has multiple accounts; set channels.signal.account to choose one.",
      } as const;
    }
    return { ok: true, error: null } as const;
  })();

  signalRestAccountHealthInFlight.set(baseUrl, pending);
  try {
    const health = await pending;
    signalRestAccountHealthCache.set(baseUrl, {
      checkedAt: Date.now(),
      health,
    });
    return health;
  } finally {
    signalRestAccountHealthInFlight.delete(baseUrl);
  }
}

async function resolveSignalRestAccount(params: {
  baseUrl: string;
  account?: string;
  timeoutMs: number;
}): Promise<string> {
  const preferred = trimString(params.account);
  if (preferred) {
    return preferred;
  }
  const accounts = await listSignalRestAccounts(params.baseUrl, params.timeoutMs);
  if (accounts.length === 1) {
    return accounts[0];
  }
  if (accounts.length === 0) {
    throw new Error(
      "Signal REST backend requires channels.signal.account (E.164 sender). No account found at /v1/accounts.",
    );
  }
  throw new Error(
    "Signal REST backend requires channels.signal.account when multiple accounts are present.",
  );
}

async function detectSignalBackend(baseUrl: string): Promise<SignalBackend> {
  const cached = signalBackendCache.get(baseUrl);
  if (cached) {
    return await cached;
  }
  const pending = (async () => {
    const fetchImpl = getRequiredFetch();
    const checkRes = await fetchWithTimeout(
      `${baseUrl}/api/v1/check`,
      { method: "GET" },
      SIGNAL_BACKEND_DETECT_TIMEOUT_MS,
      fetchImpl,
    ).catch(() => null);
    if (checkRes?.ok) {
      return { kind: "jsonrpc" } as const;
    }

    const aboutRes = await fetchWithTimeout(
      `${baseUrl}/v1/about`,
      { method: "GET" },
      SIGNAL_BACKEND_DETECT_TIMEOUT_MS,
      fetchImpl,
    ).catch(() => null);
    if (aboutRes?.ok) {
      let about: SignalRestAbout | null = null;
      try {
        about = (await aboutRes.json()) as SignalRestAbout;
      } catch {
        about = null;
      }
      return {
        kind: "rest",
        about,
      } as const;
    }

    if (checkRes) {
      const details = await readResponseSnippet(checkRes);
      throw new Error(
        details
          ? `Signal backend detection failed (api/v1/check ${checkRes.status}): ${details}`
          : `Signal backend detection failed (api/v1/check ${checkRes.status})`,
      );
    }
    if (aboutRes) {
      const details = await readResponseSnippet(aboutRes);
      throw new Error(
        details
          ? `Signal backend detection failed (/v1/about ${aboutRes.status}): ${details}`
          : `Signal backend detection failed (/v1/about ${aboutRes.status})`,
      );
    }
    throw new Error("Signal backend detection failed");
  })().catch((err) => {
    signalBackendCache.delete(baseUrl);
    throw err;
  });
  signalBackendCache.set(baseUrl, pending);
  return await pending;
}

async function signalRpcRequestJsonRpc<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  const res = await fetchWithTimeout(
    `${opts.baseUrl}/api/v1/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    getRequiredFetch(),
  );
  if (res.status === 201) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }
  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }
  return parsed.result as T;
}

async function signalRestSendRequest(params: {
  baseUrl: string;
  timeoutMs: number;
  account: string;
  message: string;
  recipients: string[];
  attachments: string[];
}): Promise<{ timestamp?: number }> {
  const attachmentBodies = await Promise.all(
    params.attachments.map(async (filePath) => {
      const buffer = await readFile(filePath);
      return buffer.toString("base64");
    }),
  );

  const payload: Record<string, unknown> = {
    number: params.account,
    recipients: params.recipients,
    message: params.message,
  };
  if (attachmentBodies.length > 0) {
    payload["base64_attachments"] = attachmentBodies;
  }

  const sendPaths = ["/v2/send", "/v1/send"];
  for (const path of sendPaths) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${params.baseUrl}${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        params.timeoutMs,
        getRequiredFetch(),
      );
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Signal REST send timed out after ${params.timeoutMs}ms (${path}). Consider increasing timeoutMs.`,
          { cause: err },
        );
      }
      throw err;
    }
    if (res.status === 404) {
      continue;
    }
    if (!res.ok) {
      const details = await readResponseSnippet(res);
      throw new Error(
        details
          ? `Signal REST send failed (${res.status}): ${details}`
          : `Signal REST send failed (${res.status})`,
      );
    }
    const text = await res.text();
    if (!text.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const timestamp = extractTimestamp(parsed);
      return typeof timestamp === "number" ? { timestamp } : {};
    } catch {
      return {};
    }
  }

  throw new Error("Signal REST send endpoint not found (/v2/send or /v1/send)");
}

async function signalRestGetAttachment(params: {
  baseUrl: string;
  timeoutMs: number;
  id: string;
}): Promise<{ data?: string }> {
  const encodedId = encodeURIComponent(params.id);
  const res = await fetchWithTimeout(
    `${params.baseUrl}/v1/attachments/${encodedId}`,
    { method: "GET" },
    params.timeoutMs,
    getRequiredFetch(),
  );
  if (!res.ok) {
    const details = await readResponseSnippet(res);
    throw new Error(
      details
        ? `Signal REST attachment fetch failed (${res.status}): ${details}`
        : `Signal REST attachment fetch failed (${res.status})`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { data: bytes.toString("base64") };
}

async function signalRpcRequestRest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (method === "version") {
    return (await fetchSignalRestAbout(opts.baseUrl, timeoutMs)) as T;
  }
  if (method === "send") {
    const sendTimeoutMs = opts.timeoutMs ?? SIGNAL_REST_SEND_TIMEOUT_MS;
    const account = await resolveSignalRestAccount({
      baseUrl: opts.baseUrl,
      account: params?.["account"] as string | undefined,
      timeoutMs: sendTimeoutMs,
    });
    const message = trimString(params?.["message"]) ?? "";
    const directRecipients = toStringArray(params?.["recipient"]);
    const usernames = toStringArray(params?.["username"]);
    const groupId = trimString(params?.["groupId"]);
    const attachments = toStringArray(params?.["attachments"]);
    const recipients = [
      ...directRecipients,
      ...usernames,
      ...(groupId ? [`group.${groupId}`] : []),
    ];
    if (recipients.length === 0) {
      throw new Error("Signal REST send requires at least one recipient");
    }
    if (!message && attachments.length === 0) {
      throw new Error("Signal send requires text or media");
    }
    return (await signalRestSendRequest({
      baseUrl: opts.baseUrl,
      timeoutMs: sendTimeoutMs,
      account,
      message,
      recipients,
      attachments,
    })) as T;
  }
  if (method === "getAttachment") {
    const id = trimString(params?.["id"]);
    if (!id) {
      throw new Error("Signal attachment id is required");
    }
    return (await signalRestGetAttachment({
      baseUrl: opts.baseUrl,
      timeoutMs,
      id,
    })) as T;
  }
  if (method === "sendTyping" || method === "sendReceipt") {
    // signal-cli-rest-api compatibility mode: typing/read receipts are best-effort no-op.
    return undefined as T;
  }
  throw new Error(`Signal REST backend does not support RPC method "${method}"`);
}

async function streamSignalEventsSse(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const url = new URL(`${params.baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      const [rawField, ...rest] = line.split(":");
      const field = rawField.trim();
      const rawValue = rest.join(":");
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }
      lineEnd = buffer.indexOf("\n");
    }
  }

  flushEvent();
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const backend = await detectSignalBackend(baseUrl);
  if (backend.kind === "jsonrpc") {
    return await signalRpcRequestJsonRpc<T>(method, params, {
      baseUrl,
      timeoutMs: opts.timeoutMs,
    });
  }
  return await signalRpcRequestRest<T>(method, params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  opts: { account?: string } = {},
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const backend = await detectSignalBackend(normalized);
    if (backend.kind === "jsonrpc") {
      const res = await fetchWithTimeout(
        `${normalized}/api/v1/check`,
        { method: "GET" },
        timeoutMs,
        getRequiredFetch(),
      );
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, error: null };
    }

    const res = await fetchWithTimeout(
      `${normalized}/v1/health`,
      { method: "GET" },
      timeoutMs,
      getRequiredFetch(),
    );
    if (!res.ok) {
      const details = await readResponseSnippet(res);
      return {
        ok: false,
        status: res.status,
        error: details ? `HTTP ${res.status}: ${details}` : `HTTP ${res.status}`,
      };
    }
    // If a specific account is configured, avoid probing /v1/accounts here.
    // That endpoint contends on signal-cli locks and can stall send/receive paths.
    if (trimString(opts.account)) {
      return { ok: true, status: res.status, error: null };
    }
    const accountHealth = await getSignalRestAccountHealth(normalized, timeoutMs);
    if (!accountHealth.ok) {
      return {
        ok: false,
        status: res.status,
        error: accountHealth.error,
      };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const backend = await detectSignalBackend(baseUrl);
  if (backend.kind === "jsonrpc") {
    await streamSignalEventsSse({
      baseUrl,
      account: params.account,
      abortSignal: params.abortSignal,
      onEvent: params.onEvent,
    });
    return;
  }

  let account = trimString(params.account);
  const fetchImpl = getRequiredFetch();
  while (!params.abortSignal?.aborted) {
    if (!account) {
      const accounts = await listSignalRestAccounts(baseUrl, DEFAULT_TIMEOUT_MS);
      if (accounts.length === 1) {
        account = accounts[0]!;
      } else if (accounts.length > 1) {
        throw new Error(
          "Signal REST backend requires channels.signal.account when multiple accounts are present.",
        );
      } else {
        await sleepAbortable(SIGNAL_REST_ACCOUNT_RETRY_DELAY_MS, params.abortSignal);
        continue;
      }
    }
    const url = new URL(`${baseUrl}/v1/receive/${encodeURIComponent(account)}`);
    url.searchParams.set("timeout", String(SIGNAL_REST_POLL_TIMEOUT_SECONDS));
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: params.abortSignal,
    });
    if (params.abortSignal?.aborted) {
      return;
    }
    if (!res.ok) {
      const details = await readResponseSnippet(res);
      throw new Error(
        details
          ? `Signal receive failed (${res.status}): ${details}`
          : `Signal receive failed (${res.status})`,
      );
    }

    const text = (await res.text()).trim();
    if (!text) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(`Signal receive returned non-JSON payload: ${String(err)}`, { cause: err });
    }

    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const eventPayload of events) {
      if (eventPayload === null || typeof eventPayload === "undefined") {
        continue;
      }
      params.onEvent({
        event: "receive",
        data: JSON.stringify(eventPayload),
      });
    }
  }
}
