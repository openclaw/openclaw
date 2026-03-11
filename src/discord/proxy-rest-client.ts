import { DiscordError, RateLimitError, RequestClient, type RequestClientOptions } from "@buape/carbon";
import { makeProxyFetch } from "../infra/net/proxy-fetch.js";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";

type RequestData = {
  body?: unknown;
  rawBody?: boolean;
  headers?: Record<string, string>;
};

type QueryParams = Record<string, string | number | boolean>;

/**
 * RequestClient variant that preserves Carbon-compatible error shapes while routing
 * all HTTP calls through a configured proxy dispatcher.
 */
export class ProxyDiscordRequestClient extends RequestClient {
  private readonly fetcher: typeof fetch;
  private readonly token: string;

  constructor(token: string, proxyUrl: string, options?: RequestClientOptions) {
    super(token, options);
    this.token = token;
    this.fetcher = wrapFetchWithAbortSignal(makeProxyFetch(proxyUrl));
  }

  override get(path: string, query?: QueryParams): Promise<unknown> {
    return this.proxyRequest("GET", path, undefined, query);
  }

  override post(path: string, data?: RequestData, query?: QueryParams): Promise<unknown> {
    return this.proxyRequest("POST", path, data, query);
  }

  override patch(path: string, data?: RequestData, query?: QueryParams): Promise<unknown> {
    return this.proxyRequest("PATCH", path, data, query);
  }

  override put(path: string, data?: RequestData, query?: QueryParams): Promise<unknown> {
    return this.proxyRequest("PUT", path, data, query);
  }

  override delete(path: string, data?: RequestData, query?: QueryParams): Promise<unknown> {
    return this.proxyRequest("DELETE", path, data, query);
  }

  private async proxyRequest(
    method: string,
    path: string,
    data?: RequestData,
    query?: QueryParams,
  ): Promise<unknown> {
    const queryString = query
      ? `?${Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("&")}`
      : "";

    const url = `${this.options.baseUrl}${path}${queryString}`;

    const headers =
      this.token === "webhook"
        ? new Headers()
        : new Headers({ Authorization: `${this.options.tokenHeader} ${this.token}` });

    if (data?.headers) {
      for (const [key, value] of Object.entries(data.headers)) {
        headers.set(key, value);
      }
    }

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
      const payload = data.body as
        | { files?: Array<{ data: BlobPart | Blob; name: string; description?: string }>; attachments?: unknown[] }
        | {
            data?: {
              files?: Array<{ data: BlobPart | Blob; name: string; description?: string }>;
            };
            attachments?: unknown[];
          };

      const normalizedPayload =
        typeof payload === "string" ? { content: payload, attachments: [] } : { ...payload, attachments: [] };

      const formData = new FormData();
      const files = "files" in payload ? payload.files || [] : payload.data?.files || [];

      for (const [index, file] of files.entries()) {
        let { data: fileData } = file;
        if (!(fileData instanceof Blob)) {
          fileData = new Blob([fileData]);
        }
        formData.append(`files[${index}]`, fileData, file.name);
        normalizedPayload.attachments.push({
          id: index,
          filename: file.name,
          description: file.description,
        });
      }

      const cleanedBody = {
        ...normalizedPayload,
        files: undefined,
      };
      formData.append("payload_json", JSON.stringify(cleanedBody));
      body = formData;
    } else if (data?.body != null) {
      headers.set("Content-Type", "application/json");
      body = data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
    }

    const controller = new AbortController();
    const timeoutMs =
      typeof this.options.timeout === "number" && this.options.timeout > 0
        ? this.options.timeout
        : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    const rawBody = await response.text().catch(() => "");
    let parsedBody: unknown;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const rateLimitBody =
        parsedBody && typeof parsedBody === "object" && "retry_after" in parsedBody && "message" in parsedBody
          ? parsedBody
          : {
              message:
                typeof parsedBody === "string"
                  ? parsedBody
                  : rawBody || "You are being rate limited.",
              retry_after:
                retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
                  ? Number(retryAfterHeader)
                  : 1,
              global: response.headers.get("X-RateLimit-Scope") === "global",
            };
      throw new RateLimitError(response, rateLimitBody as { message: string; retry_after: number; global?: boolean });
    }

    if (response.status >= 400 && response.status < 600) {
      const discordErrorBody =
        parsedBody && typeof parsedBody === "object"
          ? parsedBody
          : {
              message: rawBody || "Discord API error",
              code: 0,
            };
      throw new DiscordError(response, discordErrorBody as { message: string; code: number });
    }

    if (parsedBody !== undefined) {
      return parsedBody;
    }
    if (rawBody.length > 0) {
      return rawBody;
    }
    return null;
  }
}
