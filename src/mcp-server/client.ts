/**
 * OpenClaw Gateway HTTP Client
 *
 * Communicates with the OpenClaw gateway for agent operations,
 * memory management, and browser control.
 */

export interface GatewayClientOptions {
  baseUrl: string;
  timeout?: number;
}

export interface GatewayResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export class GatewayClient {
  private baseUrl: string;
  private timeout: number;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeout = options.timeout ?? 30_000;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GatewayResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const contentType = response.headers.get("content-type");
      let data: T | undefined;

      if (contentType?.includes("application/json")) {
        data = (await response.json()) as T;
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error)
            : `HTTP ${response.status}`,
        };
      }

      return { ok: true, status: response.status, data };
    } catch (err) {
      clearTimeout(timeoutId);
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Agent Operations
  async sendMessage(params: {
    message: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<GatewayResponse<{ response: string; sessionKey: string }>> {
    return this.request("POST", "/api/agent/message", params);
  }

  async getAgentStatus(agentId?: string): Promise<GatewayResponse<{
    agentId: string;
    status: string;
    sessions: number;
  }>> {
    const path = agentId ? `/api/agent/${agentId}/status` : "/api/agent/status";
    return this.request("GET", path);
  }

  async listSessions(params?: {
    agentId?: string;
    limit?: number;
  }): Promise<GatewayResponse<{ sessions: Array<{ key: string; updatedAt: string }> }>> {
    const query = new URLSearchParams();
    if (params?.agentId) query.set("agentId", params.agentId);
    if (params?.limit) query.set("limit", String(params.limit));
    const path = `/api/sessions${query.toString() ? `?${query}` : ""}`;
    return this.request("GET", path);
  }

  async getSession(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<GatewayResponse<{ messages: Array<{ role: string; content: string }> }>> {
    const query = params.limit ? `?limit=${params.limit}` : "";
    return this.request("GET", `/api/sessions/${encodeURIComponent(params.sessionKey)}${query}`);
  }

  // Memory Operations
  async memorySearch(params: {
    query: string;
    limit?: number;
    threshold?: number;
  }): Promise<GatewayResponse<{ results: Array<{ content: string; score: number }> }>> {
    return this.request("POST", "/api/memory/search", params);
  }

  async memoryAdd(params: {
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<GatewayResponse<{ id: string }>> {
    return this.request("POST", "/api/memory/add", params);
  }

  // Skill Execution
  async executeSkill(params: {
    skill: string;
    args?: string;
    agentId?: string;
  }): Promise<GatewayResponse<{ output: string }>> {
    return this.request("POST", "/api/skill/execute", params);
  }

  // Browser Control
  async browserAction(params: {
    action: string;
    url?: string;
    selector?: string;
    text?: string;
    profile?: string;
  }): Promise<GatewayResponse<{ result: unknown }>> {
    return this.request("POST", "/api/browser/action", params);
  }

  // File Operations
  async readFile(params: {
    path: string;
    encoding?: string;
  }): Promise<GatewayResponse<{ content: string }>> {
    return this.request("POST", "/api/workspace/read", params);
  }

  async listFiles(params?: {
    path?: string;
    pattern?: string;
  }): Promise<GatewayResponse<{ files: string[] }>> {
    return this.request("POST", "/api/workspace/list", params ?? {});
  }
}
