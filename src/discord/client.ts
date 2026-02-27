import { RateLimitError, RequestClient } from "@buape/carbon";
import { loadConfig } from "../config/config.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { resolveDiscordAccount } from "./accounts.js";
import { makeDiscordProxyFetch } from "./proxy.js";
import { normalizeDiscordToken } from "./token.js";

/** Default timeout for Discord API requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Builds a query string from a query object.
 * Handles array values using Discord API's comma-separated format.
 */
export function buildQueryString(
  query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
): string {
  if (!query || Object.keys(query).length === 0) {
    return "";
  }
  const queryPart = Object.entries(query)
    .flatMap(([key, value]) => {
      // Handle array values - Discord API supports array params like roles=1,2,3
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return [];
        }
        // Discord API uses comma-separated values for array params
        return [
          `${encodeURIComponent(key)}=${value.map((v) => encodeURIComponent(String(v))).join(",")}`,
        ];
      }
      return [`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`];
    })
    .join("&");
  return queryPart ? `?${queryPart}` : "";
}

export type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { explicit?: string; accountId: string; fallbackToken?: string }) {
  const explicit = normalizeDiscordToken(params.explicit);
  if (explicit) {
    return explicit;
  }
  const fallback = normalizeDiscordToken(params.fallbackToken);
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

/**
 * Creates a RequestClient that routes all Discord API requests through the specified proxy.
 * Carbon's RequestClient doesn't support custom fetch, so we create a subclass that
 * overrides the internal request execution to use our proxied fetch.
 */
export class ProxiedRequestClient extends RequestClient {
  private readonly proxyFetch: typeof fetch;
  private readonly discordToken: string;

  constructor(token: string, proxyUrl: string) {
    super(token);
    this.discordToken = token;
    this.proxyFetch = makeDiscordProxyFetch(proxyUrl);
  }

  // Carbon's RequestClient uses fetch internally in executeRequest, which is private.
  // We override the public methods to use our proxied fetch instead.
  // This is a workaround until Carbon supports custom fetch natively.
  override async get(
    path: string,
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("GET", path, undefined, query);
  }

  override async post(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("POST", path, data, query);
  }

  override async patch(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("PATCH", path, data, query);
  }

  override async put(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("PUT", path, data, query);
  }

  override async delete(
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ) {
    return this.proxiedRequest("DELETE", path, data, query);
  }

  private async proxiedRequest(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    data?: { body?: unknown; rawBody?: boolean; headers?: Record<string, string> },
    query?: Record<string, string | number | boolean | readonly (string | number | boolean)[]>,
  ): Promise<unknown> {
    const queryString = buildQueryString(query);
    const url = `${this.options.baseUrl}/v${this.options.apiVersion}${path}${queryString}`;

    // Strip any existing "Bot" prefix to avoid "Bot Bot token" format
    const normalizedToken = this.discordToken.replace(/^Bot\s+/i, "");
    const headers = new Headers({
      Authorization: `${this.options.tokenHeader} ${normalizedToken}`,
      "User-Agent": this.options.userAgent ?? "DiscordBot",
    });

    if (data?.headers) {
      for (const [key, value] of Object.entries(data.headers)) {
        headers.set(key, value);
      }
    }

    let body: BodyInit | undefined;
    if (data?.body != null) {
      if (data.rawBody) {
        body = data.body as BodyInit;
      } else if (data.body instanceof FormData) {
        // Preserve FormData for multipart uploads (attachments, files)
        body = data.body;
        // Don't set Content-Type - let fetch/FormData set it with boundary
        headers.delete("Content-Type");
      } else if (
        typeof data.body === "object" &&
        "files" in data.body &&
        Array.isArray((data.body as { files?: unknown[] }).files)
      ) {
        // Handle Discord file uploads - convert to FormData with attachments
        // This mirrors Carbon's RequestClient behavior for files
        const payload = {
          ...data.body,
          attachments: [] as { id: number; filename: string; description?: string }[],
        };
        const files =
          (payload as { files?: { data: Blob | Uint8Array; name: string; description?: string }[] })
            .files || [];
        const formData = new FormData();

        for (const [index, file] of files.entries()) {
          let fileData = file.data;
          if (!(fileData instanceof Blob)) {
            // Convert Uint8Array to Blob safely - Uint8Array is handled correctly by Blob constructor
            // This preserves byteOffset/byteLength when the array is a slice
            fileData = new Blob([fileData as BlobPart]);
          }
          formData.append(`files[${index}]`, fileData, file.name);
          payload.attachments.push({
            id: index,
            filename: file.name,
            description: file.description,
          });
        }

        // Remove files from payload and add as payload_json
        const cleanedPayload = { ...payload, files: undefined };
        formData.append("payload_json", JSON.stringify(cleanedPayload));
        body = formData;
        // Don't set Content-Type - let fetch/FormData set it with boundary
        headers.delete("Content-Type");
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(data.body);
      }
    }

    // Handle timeout: undefined/null uses default, 0 means no timeout, >0 uses the value
    let timeoutMs: number | undefined;
    if (typeof this.options.timeout === "number") {
      // Allow 0 to mean "no timeout" (don't set AbortController timeout)
      timeoutMs = this.options.timeout >= 0 ? this.options.timeout : DEFAULT_TIMEOUT_MS;
    } else {
      timeoutMs = DEFAULT_TIMEOUT_MS;
    }

    const controller = new AbortController();
    // Only set timeout if timeoutMs > 0 (0 means no timeout)
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const response = await this.proxyFetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      // Handle 429 Rate Limit errors - preserve Carbon's RateLimitError for retry mechanism
      if (response.status === 429) {
        let parsedBody: unknown;
        try {
          parsedBody = await response.json();
        } catch {
          parsedBody = undefined;
        }

        // Calculate retry_after from multiple sources
        const calculateRetryAfter = (): number => {
          // First priority: retry_after in response body
          if (
            parsedBody &&
            typeof parsedBody === "object" &&
            "retry_after" in parsedBody &&
            typeof (parsedBody as { retry_after: unknown }).retry_after === "number"
          ) {
            return (parsedBody as { retry_after: number }).retry_after;
          }

          // Second priority: Retry-After header (seconds)
          const retryAfterHeader = response.headers.get("Retry-After");
          if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
            return Number(retryAfterHeader);
          }

          // Third priority: X-RateLimit-Reset header (Unix timestamp in seconds)
          const resetHeader = response.headers.get("X-RateLimit-Reset");
          if (resetHeader) {
            const resetTimestamp = Number(resetHeader);
            if (!Number.isNaN(resetTimestamp)) {
              // Convert Unix timestamp to seconds from now
              const now = Math.floor(Date.now() / 1000);
              const waitSeconds = Math.max(0, resetTimestamp - now);
              return waitSeconds;
            }
          }

          // Default fallback: 1 second
          return 1;
        };

        const rateLimitBody =
          parsedBody &&
          typeof parsedBody === "object" &&
          "retry_after" in parsedBody &&
          "message" in parsedBody
            ? {
                message: (parsedBody as { message: string }).message,
                retry_after: (parsedBody as { retry_after: number }).retry_after,
                global: !!(parsedBody as { global?: boolean }).global,
              }
            : {
                message:
                  typeof parsedBody === "string" ? parsedBody : "You are being rate limited.",
                retry_after: calculateRetryAfter(),
                global: response.headers.get("X-RateLimit-Scope") === "global",
              };

        throw new RateLimitError(response, rateLimitBody);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = undefined;
        }
        const error = new Error(
          `Discord API error (${response.status}): ${text.slice(0, 500)}`,
        ) as Error & {
          status: number;
          code?: number;
          rawError?: unknown;
          body?: unknown;
        };
        error.status = response.status;
        // Preserve Discord error fields for downstream error handling
        if (parsedBody && typeof parsedBody === "object") {
          const body = parsedBody as { code?: unknown; message?: unknown };
          if (typeof body.code === "number") {
            error.code = body.code;
          }
          error.body = parsedBody;
          error.rawError = parsedBody;
        }
        throw error;
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined;
      }

      return response.json();
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

function resolveRest(token: string, proxyUrl?: string, rest?: RequestClient): RequestClient {
  if (rest) {
    return rest;
  }
  const proxy = proxyUrl?.trim();
  if (proxy) {
    try {
      return new ProxiedRequestClient(token, proxy);
    } catch (error) {
      // Fall back to default RequestClient if proxy is invalid
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `Failed to create proxied request client: ${errorMessage}. Using default client.`,
      );
      return new RequestClient(token);
    }
  }
  return new RequestClient(token);
}

export function createDiscordRestClient(opts: DiscordClientOpts, cfg = loadConfig()) {
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });
  const proxyUrl = account.config.proxy;
  const rest = resolveRest(token, proxyUrl, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg = loadConfig(),
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts).rest;
}
