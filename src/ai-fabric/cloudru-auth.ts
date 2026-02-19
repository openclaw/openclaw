/**
 * Cloud.ru AI Fabric — IAM Token Management
 *
 * Exchanges keyId + secret for a Bearer token and caches it.
 * Auto-refreshes before expiry (configurable margin).
 *
 * Pattern: mirrors github-copilot-token.ts (cache + refresh).
 */

import type { CloudruAuthConfig, ResolvedToken, CloudruTokenResponse } from "./types.js";
import { describeNetworkError } from "../infra/errors.js";
import { resolveFetch } from "../infra/fetch.js";
import {
  CLOUDRU_IAM_TOKEN_URL,
  CLOUDRU_DEFAULT_TIMEOUT_MS,
  CLOUDRU_TOKEN_REFRESH_MARGIN_MS,
} from "./constants.js";

export class CloudruAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CloudruAuthError";
    this.status = status;
  }
}

export type CloudruAuthOptions = {
  iamUrl?: string;
  timeoutMs?: number;
  refreshMarginMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Stateful token provider. Create one instance per config and reuse it.
 */
export class CloudruTokenProvider {
  private readonly config: CloudruAuthConfig;
  private readonly iamUrl: string;
  private readonly timeoutMs: number;
  private readonly refreshMarginMs: number;
  private readonly fetchImpl: typeof fetch;

  private cached: ResolvedToken | null = null;
  private inflightExchange: Promise<ResolvedToken> | null = null;

  constructor(config: CloudruAuthConfig, options?: CloudruAuthOptions) {
    this.config = config;
    this.iamUrl = options?.iamUrl ?? CLOUDRU_IAM_TOKEN_URL;
    this.timeoutMs = options?.timeoutMs ?? CLOUDRU_DEFAULT_TIMEOUT_MS;
    this.refreshMarginMs = options?.refreshMarginMs ?? CLOUDRU_TOKEN_REFRESH_MARGIN_MS;
    this.fetchImpl = resolveFetch(options?.fetchImpl) ?? fetch;
  }

  /**
   * Get a valid token. Returns cached token if still fresh,
   * otherwise exchanges credentials for a new one.
   */
  async getToken(): Promise<ResolvedToken> {
    if (this.cached && !this.isExpiringSoon(this.cached)) {
      return this.cached;
    }

    // Deduplicate concurrent exchanges
    if (!this.inflightExchange) {
      this.inflightExchange = this.exchange().finally(() => {
        this.inflightExchange = null;
      });
    }
    return this.inflightExchange;
  }

  /** Clear cached token (for tests or forced re-auth). */
  clearCache(): void {
    this.cached = null;
    this.inflightExchange = null;
  }

  private isExpiringSoon(token: ResolvedToken): boolean {
    return Date.now() >= token.expiresAt - this.refreshMarginMs;
  }

  private async exchange(): Promise<ResolvedToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(this.iamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyId: this.config.keyId,
          secret: this.config.secret,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CloudruAuthError(
          `IAM token exchange failed (${res.status}): ${text || "no details"}`,
          res.status,
        );
      }

      const body = (await res.json()) as CloudruTokenResponse;

      // Cloud.ru IAM returns { access_token, expires_in }; support legacy { token, expiresAt } too
      const token = body.access_token ?? body.token;
      if (!token) {
        throw new CloudruAuthError("IAM token response missing access_token (or token)");
      }

      let expiresAt: number;
      if (typeof body.expires_in === "number" && body.expires_in > 0) {
        expiresAt = Date.now() + body.expires_in * 1000;
      } else if (body.expiresAt) {
        expiresAt = new Date(body.expiresAt).getTime();
      } else {
        // Default to 1 hour if neither field is present
        expiresAt = Date.now() + 3600_000;
      }

      const resolved: ResolvedToken = { token, expiresAt };

      this.cached = resolved;
      return resolved;
    } catch (err) {
      if (err instanceof CloudruAuthError) {
        throw err;
      }
      throw new CloudruAuthError(`IAM token exchange failed: ${describeNetworkError(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
