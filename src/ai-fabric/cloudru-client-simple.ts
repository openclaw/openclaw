/**
 * Cloud.ru AI Fabric — Simple Client with IAM Auth
 *
 * Lightweight HTTP client for the Cloud.ru AI Agents API.
 * Uses IAM token exchange (keyId + secret → Bearer token) via
 * CloudruTokenProvider, with automatic caching and refresh.
 *
 * For wizard/onboarding flows and MCP server discovery.
 */

import type {
  CloudruAuthConfig,
  CloudruApiErrorPayload,
  PaginatedResult,
  McpServer,
  ListMcpServersParams,
  Agent,
  ListAgentsParams,
  AgentSystem,
  ListAgentSystemsParams,
} from "./types.js";
import { isRetryableNetworkError } from "../infra/errors.js";
import { resolveFetch } from "../infra/fetch.js";
import { resolveRetryConfig, retryAsync } from "../infra/retry.js";
import { CloudruTokenProvider, type CloudruAuthOptions } from "./cloudru-auth.js";
import { CloudruApiError } from "./cloudru-client.js";
import {
  CLOUDRU_AI_AGENTS_BASE_URL,
  CLOUDRU_DEFAULT_TIMEOUT_MS,
  CLOUDRU_RETRY_DEFAULTS,
  CLOUDRU_DEFAULT_PAGE_SIZE,
} from "./constants.js";

export type CloudruSimpleClientConfig = {
  /** Cloud.ru AI Fabric project ID. */
  projectId: string;
  /** IAM credentials (keyId + secret) for token exchange. */
  auth: CloudruAuthConfig;
  /** Override AI Agents base URL (for testing). */
  baseUrl?: string;
  /** Override IAM token URL (for testing). */
  iamUrl?: string;
  /** HTTP request timeout in ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

export class CloudruSimpleClient {
  readonly projectId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: CloudruTokenProvider;

  constructor(config: CloudruSimpleClientConfig) {
    this.projectId = config.projectId;
    this.baseUrl = (config.baseUrl ?? CLOUDRU_AI_AGENTS_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? CLOUDRU_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = resolveFetch(config.fetchImpl) ?? fetch;

    const authOpts: CloudruAuthOptions = {
      iamUrl: config.iamUrl,
      timeoutMs: this.timeoutMs,
      fetchImpl: config.fetchImpl,
    };
    this.tokenProvider = new CloudruTokenProvider(config.auth, authOpts);
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.projectId}${path}`;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const retryConfig = resolveRetryConfig(CLOUDRU_RETRY_DEFAULTS);

    return retryAsync(
      async () => {
        const token = await this.tokenProvider.getToken();

        let fullUrl = this.url(path);
        if (query) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              params.set(key, String(value));
            }
          }
          const qs = params.toString();
          if (qs) {
            fullUrl += `?${qs}`;
          }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const res = await this.fetchImpl(fullUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token.token}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            const payload = parseErrorPayload(text);
            const detail = payload?.message ?? (text || `HTTP ${res.status}`);

            throw new CloudruApiError(
              `Cloud.ru API GET ${path} failed (${res.status}): ${detail}`,
              res.status,
              payload?.code,
            );
          }

          return (await res.json()) as T;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        ...retryConfig,
        label: `GET ${path}`,
        shouldRetry: (err) => {
          if (err instanceof CloudruApiError) {
            return err.status === 429 || err.status >= 500;
          }
          return isRetryableNetworkError(err);
        },
      },
    );
  }

  /** List MCP servers available in the project. */
  async listMcpServers(params?: ListMcpServersParams): Promise<PaginatedResult<McpServer>> {
    return this.get<PaginatedResult<McpServer>>("/mcpServers", {
      search: params?.search,
      limit: params?.limit ?? CLOUDRU_DEFAULT_PAGE_SIZE,
      offset: params?.offset ?? 0,
    });
  }

  /** List AI Agents available in the project. */
  async listAgents(params?: ListAgentsParams): Promise<PaginatedResult<Agent>> {
    return this.get<PaginatedResult<Agent>>("/agents", {
      search: params?.search,
      status: params?.status,
      limit: params?.limit ?? CLOUDRU_DEFAULT_PAGE_SIZE,
      offset: params?.offset ?? 0,
    });
  }

  /** Get a single agent by ID. */
  async getAgent(agentId: string): Promise<Agent> {
    return this.get<Agent>(`/agents/${agentId}`);
  }

  /** List Agent Systems available in the project. */
  async listAgentSystems(params?: ListAgentSystemsParams): Promise<PaginatedResult<AgentSystem>> {
    return this.get<PaginatedResult<AgentSystem>>("/agentSystems", {
      search: params?.search,
      status: params?.status,
      limit: params?.limit ?? CLOUDRU_DEFAULT_PAGE_SIZE,
      offset: params?.offset ?? 0,
    });
  }

  /** Get a single agent system by ID. */
  async getAgentSystem(systemId: string): Promise<AgentSystem> {
    return this.get<AgentSystem>(`/agentSystems/${systemId}`);
  }

  /** Clear the auth token cache (for tests or forced re-auth). */
  clearAuthCache(): void {
    this.tokenProvider.clearCache();
  }
}

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
