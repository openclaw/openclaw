import {
  DiscordError,
  RateLimitError,
  RequestClient,
  type QueuedRequest,
  type RequestData,
} from "@buape/carbon";
import { makeProxyFetch } from "../infra/net/proxy-fetch.js";

const DISCORD_REQUEST_CLIENT_PROXY_URL = Symbol.for("openclaw.discord.requestClient.proxyUrl");

type DiscordRateLimitBody = ConstructorParameters<typeof RateLimitError>[1];
type DiscordErrorBody = ConstructorParameters<typeof DiscordError>[1];

type RequestClientProxyTarget = {
  abortController: AbortController | null;
  executeRequest: (request: QueuedRequest) => Promise<unknown>;
  options: RequestClient["options"];
  scheduleRateLimit: (routeKey: string, path: string, error: RateLimitError) => void;
  updateBucketFromHeaders: (routeKey: string, path: string, response: Response) => void;
  waitForBucket: (routeKey: string) => Promise<void>;
  [DISCORD_REQUEST_CLIENT_PROXY_URL]?: string;
};

function readToken(rest: RequestClient): string {
  return (rest as unknown as { token: string }).token;
}

function buildRequestUrl(
  rest: RequestClientProxyTarget,
  path: string,
  query?: QueuedRequest["query"],
) {
  const queryString = query
    ? `?${Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&")}`
    : "";
  return `${rest.options.baseUrl}${path}${queryString}`;
}

function buildHeaders(rest: RequestClientProxyTarget, token: string, data?: RequestData): Headers {
  const headers =
    token === "webhook"
      ? new Headers()
      : new Headers({
          Authorization: `${rest.options.tokenHeader} ${token}`,
        });

  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }

  return headers;
}

function buildRequestBody(params: { headers: Headers; data?: RequestData }): BodyInit | undefined {
  const { headers, data } = params;
  if (
    data?.body &&
    typeof FormData !== "undefined" &&
    "files" in (data.body as Record<string, unknown>)
  ) {
    const formData = new FormData();
    const payload = data.body as {
      files?: Array<{ data: Blob; name: string; description?: string }>;
      attachments?: Array<Record<string, unknown>>;
    };
    payload.files?.forEach((file, index) => {
      formData.append(`files[${index}]`, file.data, file.name);
    });
    if (payload.attachments == null) {
      payload.attachments = [];
    }
    payload.files?.forEach((file, index) => {
      payload.attachments?.push({
        id: index,
        filename: file.name,
        description: file.description,
      });
    });
    formData.append(
      "payload_json",
      JSON.stringify({
        ...payload,
        files: undefined,
      }),
    );
    return formData;
  }

  if (data?.body != null) {
    headers.set("Content-Type", "application/json");
    return data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
  }

  return undefined;
}

async function executeRequestWithProxy(
  rest: RequestClientProxyTarget,
  token: string,
  fetchImpl: typeof fetch,
  request: QueuedRequest,
): Promise<unknown> {
  const { method, path, data, query, routeKey } = request;
  await rest.waitForBucket(routeKey);

  const url = buildRequestUrl(rest, path, query);
  const headers = buildHeaders(rest, token, data);
  const body = buildRequestBody({ headers, data });

  rest.abortController = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (rest.options.timeout !== undefined) {
    timeoutId = setTimeout(() => {
      rest.abortController?.abort();
    }, rest.options.timeout);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: rest.abortController.signal,
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
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
    const rateLimitBody: DiscordRateLimitBody =
      parsedBody &&
      typeof parsedBody === "object" &&
      "retry_after" in parsedBody &&
      "message" in parsedBody &&
      "global" in parsedBody
        ? (parsedBody as DiscordRateLimitBody)
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
    const rateLimitError = new RateLimitError(response, rateLimitBody);
    rest.scheduleRateLimit(routeKey, path, rateLimitError);
    throw rateLimitError;
  }

  rest.updateBucketFromHeaders(routeKey, path, response);

  if (response.status >= 400 && response.status < 600) {
    const discordErrorBody: DiscordErrorBody =
      parsedBody &&
      typeof parsedBody === "object" &&
      "message" in parsedBody &&
      "code" in parsedBody
        ? (parsedBody as DiscordErrorBody)
        : {
            message: rawBody || "Discord API error",
            code: 0,
          };
    throw new DiscordError(response, discordErrorBody);
  }

  if (parsedBody !== undefined) {
    return parsedBody;
  }
  if (rawBody.length > 0) {
    return rawBody;
  }
  return null;
}

export function applyDiscordProxyToRequestClient(
  rest: RequestClient,
  proxyUrl: string | undefined,
): RequestClient {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return rest;
  }

  const internal = rest as unknown as RequestClientProxyTarget;
  if (internal[DISCORD_REQUEST_CLIENT_PROXY_URL] === proxy) {
    return rest;
  }

  const proxyFetch = makeProxyFetch(proxy);
  const token = readToken(rest);
  internal.executeRequest = (request: QueuedRequest) =>
    executeRequestWithProxy(internal, token, proxyFetch, request);

  Object.defineProperty(internal, DISCORD_REQUEST_CLIENT_PROXY_URL, {
    value: proxy,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return rest;
}
