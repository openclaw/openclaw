/**
 * Cloud.ru AI Fabric — Base HTTP Client
 *
 * Generic JSON HTTP client for the Cloud.ru AI Agents API.
 * Handles authentication (via CloudruTokenProvider), retry with
 * exponential backoff, timeout, and error normalization.
 *
 * Pattern: mirrors discord/api.ts (fetch + retry + typed errors).
 */

import type { CloudruClientConfig, CloudruApiErrorPayload } from "./types.js";
import { isRetryableNetworkError } from "../infra/errors.js";
import { resolveFetch } from "../infra/fetch.js";
import { resolveRetryConfig, retryAsync, type RetryConfig } from "../infra/retry.js";
import { CloudruTokenProvider, type CloudruAuthOptions } from "./cloudru-auth.js";
import {
  CLOUDRU_AI_AGENTS_BASE_URL,
  CLOUDRU_DEFAULT_TIMEOUT_MS,
  CLOUDRU_RETRY_DEFAULTS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CloudruApiError extends Error {
  status: number;
  code?: string;
  retryAfter?: number;

  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = "CloudruApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CloudruClient {
  readonly projectId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryConfig: Required<RetryConfig>;
  private readonly tokenProvider: CloudruTokenProvider;

  constructor(config: CloudruClientConfig) {
    this.projectId = config.projectId;
    this.baseUrl = (config.baseUrl ?? CLOUDRU_AI_AGENTS_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? CLOUDRU_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = resolveFetch(config.fetchImpl) ?? fetch;
    this.retryConfig = resolveRetryConfig(CLOUDRU_RETRY_DEFAULTS);

    const authOpts: CloudruAuthOptions = {
      iamUrl: config.iamUrl,
      timeoutMs: this.timeoutMs,
      fetchImpl: config.fetchImpl,
    };
    this.tokenProvider = new CloudruTokenProvider(config.auth, authOpts);
  }

  /** Build the full URL for a project-scoped path. */
  private url(path: string): string {
    return `${this.baseUrl}/${this.projectId}${path}`;
  }

  /**
   * Make an authenticated JSON request with retry.
   * Returns the parsed JSON body, or undefined for 204 No Content.
   */
  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      retry?: RetryConfig;
    },
  ): Promise<T> {
    const retryConfig = resolveRetryConfig(this.retryConfig, options?.retry);

    return retryAsync(
      async () => {
        const token = await this.tokenProvider.getToken();

        let fullUrl = this.url(path);
        if (options?.query) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.query)) {
            if (value !== undefined) {
              params.set(key, String(value));
            }
          }
          const qs = params.toString();
          if (qs) {
            fullUrl += `?${qs}`;
          }
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const res = await this.fetchImpl(fullUrl, {
            method,
            headers,
            body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });

          if (res.status === 204) {
            return undefined as T;
          }

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            const payload = parseErrorPayload(text);
            const detail = payload?.message ?? (text || `HTTP ${res.status}`);
            const retryAfter = parseRetryAfterHeader(res);

            throw new CloudruApiError(
              `Cloud.ru API ${method} ${path} failed (${res.status}): ${detail}`,
              res.status,
              payload?.code,
              retryAfter,
            );
          }

          return (await res.json()) as T;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        ...retryConfig,
        label: `${method} ${path}`,
        shouldRetry: (err) => {
          if (err instanceof CloudruApiError) {
            return err.status === 429 || err.status >= 500;
          }
          return isRetryableNetworkError(err);
        },
        retryAfterMs: (err) =>
          err instanceof CloudruApiError && typeof err.retryAfter === "number"
            ? err.retryAfter * 1000
            : undefined,
      },
    );
  }

  /** Convenience: GET */
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  /** Convenience: POST */
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** Convenience: PATCH */
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  /** Convenience: DELETE */
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /** Clear the auth token cache (for tests or forced re-auth). */
  clearAuthCache(): void {
    this.tokenProvider.clearCache();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseErrorPayload(text: string): CloudruApiErrorPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CloudruApiErrorPayload;
  } catch {
    return null;
  }
}

function parseRetryAfterHeader(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}
