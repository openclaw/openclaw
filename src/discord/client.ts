import { DiscordError, RateLimitError, RequestClient, type QueuedRequest } from "@buape/carbon";
import { loadConfig } from "../config/config.js";
import { makeProxyFetch } from "../infra/net/proxy-fetch.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { logWarn } from "../logger.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { accountId: string; fallbackToken?: string }) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

type ProxyAwareRequestClient = {
  options: RequestClient["options"];
  executeRequest: (request: QueuedRequest) => Promise<unknown>;
  scheduleRateLimit(routeKey: string, path: string, error: RateLimitError): void;
  updateBucketFromHeaders(routeKey: string, path: string, response: Response): void;
  waitForBucket(routeKey: string): Promise<void>;
};

type RequestClientAbortState = {
  abortController?: AbortController | null;
};

type DiscordUploadFile = {
  data: Blob | Buffer | ArrayBuffer | ArrayBufferView | string;
  name: string;
  description?: string;
};

type DiscordMultipartBody = Record<string, unknown> & {
  attachments?: Array<{ id: number; filename: string; description?: string }>;
  files?: DiscordUploadFile[];
  data?: Record<string, unknown> & { files?: DiscordUploadFile[] };
};

function toBlobPart(value: DiscordUploadFile["data"]): BlobPart {
  if (typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes;
  }
  return String(value);
}

function buildDiscordQueryString(query?: QueuedRequest["query"]) {
  if (!query) {
    return "";
  }
  return `?${Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")}`;
}

async function executeRequestWithFetch(
  client: ProxyAwareRequestClient,
  abortState: RequestClientAbortState,
  token: string,
  request: QueuedRequest,
  fetcher: typeof fetch,
): Promise<unknown> {
  const { method, path, data, query, routeKey } = request;
  await client.waitForBucket(routeKey);

  const url = `${client.options.baseUrl}${path}${buildDiscordQueryString(query)}`;
  const headers =
    token === "webhook"
      ? new Headers()
      : new Headers({
          Authorization: `${client.options.tokenHeader} ${token}`,
        });

  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }

  const timeoutMs =
    typeof client.options.timeout === "number" && client.options.timeout > 0
      ? client.options.timeout
      : undefined;
  let body: BodyInit | undefined;

  if (
    data?.body &&
    typeof data.body === "object" &&
    ("files" in data.body ||
      ("data" in data.body &&
        data.body.data &&
        typeof data.body.data === "object" &&
        "files" in data.body.data))
  ) {
    const payload = data.body as DiscordMultipartBody;
    data.body = { ...payload, attachments: [] } satisfies DiscordMultipartBody;
    const multipartBody = data.body as DiscordMultipartBody;
    const formData = new FormData();
    const files = (() => {
      if (Array.isArray(payload.files)) {
        return payload.files;
      }
      if (payload.data && typeof payload.data === "object" && Array.isArray(payload.data.files)) {
        return payload.data.files;
      }
      return [] as DiscordUploadFile[];
    })();

    for (const [index, file] of files.entries()) {
      let { data: fileData } = file;
      if (!(fileData instanceof Blob)) {
        fileData = new Blob([toBlobPart(fileData)]);
      }
      formData.append(`files[${index}]`, fileData, file.name);
      multipartBody.attachments?.push({
        id: index,
        filename: file.name,
        description: file.description,
      });
    }

    if (multipartBody != null) {
      const cleanedBody = {
        ...multipartBody,
        files: undefined,
      };
      formData.append("payload_json", JSON.stringify(cleanedBody));
    }
    body = formData;
  } else if (data?.body != null) {
    headers.set("Content-Type", "application/json");
    body = data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      abortState.abortController?.abort();
    }, timeoutMs);
  }

  let response: Response;
  abortState.abortController = new AbortController();
  try {
    response = await fetcher(url, {
      method,
      headers,
      body,
      signal: abortState.abortController.signal,
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    abortState.abortController = null;
  }

  let rawBody = "";
  let parsedBody: unknown;
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }

  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = undefined;
    }
  }

  if (response.status === 429) {
    const rateLimitBody =
      parsedBody &&
      typeof parsedBody === "object" &&
      "retry_after" in parsedBody &&
      "message" in parsedBody
        ? parsedBody
        : {
            message:
              typeof parsedBody === "string"
                ? parsedBody
                : rawBody || "You are being rate limited.",
            retry_after: (() => {
              const retryAfterHeader = response.headers.get("Retry-After");
              if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
                return Number(retryAfterHeader);
              }
              return 1;
            })(),
            global: response.headers.get("X-RateLimit-Scope") === "global",
          };
    const rateLimitError = new RateLimitError(
      response,
      rateLimitBody as {
        message: string;
        retry_after: number;
        global: boolean;
      },
    );
    client.scheduleRateLimit(routeKey, path, rateLimitError);
    throw rateLimitError;
  }

  client.updateBucketFromHeaders(routeKey, path, response);

  if (response.status >= 400 && response.status < 600) {
    const discordErrorBody =
      parsedBody && typeof parsedBody === "object"
        ? parsedBody
        : {
            message: rawBody || "Discord API error",
            code: 0,
          };
    throw new DiscordError(
      response,
      discordErrorBody as {
        message: string;
        code: number;
      },
    );
  }

  if (parsedBody !== undefined) {
    return parsedBody;
  }
  if (rawBody.length > 0) {
    return rawBody;
  }
  return null;
}

function attachDiscordRestFetch(
  client: RequestClient,
  token: string,
  fetcher: typeof fetch,
): RequestClient {
  const proxyAwareClient = client as unknown as ProxyAwareRequestClient;
  const abortState = client as unknown as RequestClientAbortState;
  proxyAwareClient.executeRequest = (request) =>
    executeRequestWithFetch(proxyAwareClient, abortState, token, request, fetcher);
  return client;
}

function resolveRest(token: string, proxyUrl: string | undefined, rest?: RequestClient) {
  if (rest) {
    return rest;
  }

  const client = new RequestClient(token);
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return client;
  }

  try {
    return attachDiscordRestFetch(client, token, makeProxyFetch(proxy));
  } catch (err) {
    logWarn(
      `discord: invalid rest proxy: ${err instanceof Error ? err.message : String(err)}. Falling back to direct REST fetch.`,
    );
    return client;
  }
}

function resolveAccountWithoutToken(params: {
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token: "",
    tokenSource: "none",
    config: merged,
  };
}

export function createDiscordRestClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
) {
  const resolvedCfg = opts.cfg ?? cfg ?? loadConfig();
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const account = explicitToken
    ? resolveAccountWithoutToken({ cfg: resolvedCfg, accountId: opts.accountId })
    : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token =
    explicitToken ??
    resolveToken({
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const rest = resolveRest(token, account.config.proxy, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg?: ReturnType<typeof loadConfig>,
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, opts.cfg ?? cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts, opts.cfg).rest;
}
