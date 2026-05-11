/**
 * HTTP client for the AgentGlob dashboard's Rain runtime endpoints.
 *
 * Reads AGENTGLOB_RUNTIME_URL and AGENTGLOB_RUNTIME_TOKEN from process
 * environment (injected by the deploy flow when Rain is selected — see
 * openclaw-dashboard PLATFORM_INTEGRATIONS_V1_ARCHITECTURE.md §1a). The
 * canonical compose file forwards these into the container (the V1.5-pre
 * commit on openclaw/main); the openclaw gateway then propagates them to
 * spawned MCP child processes.
 *
 * Throws RuntimeClientError on non-2xx responses; preserves the runtime's
 * `code` field for typed downstream handling.
 */

export interface RuntimeClientErrorPayload {
  ok: false;
  error: string;
  code?: string;
}

export class RuntimeClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }
}

interface RuntimeClientConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class RainRuntimeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RuntimeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  static fromEnv(): RainRuntimeClient {
    const url = process.env.AGENTGLOB_RUNTIME_URL;
    const token = process.env.AGENTGLOB_RUNTIME_TOKEN;
    if (!url || !token) {
      throw new RuntimeClientError(
        0,
        "missing_env",
        "Rain MCP requires AGENTGLOB_RUNTIME_URL and AGENTGLOB_RUNTIME_TOKEN in the environment. Redeploy the agent from the dashboard so these are populated.",
      );
    }
    return new RainRuntimeClient({ baseUrl: url, token });
  }

  async listMarkets(params: {
    limit?: number;
    offset?: number;
    status?: string;
    sortBy?: string;
    creator?: string;
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) {
      qs.set("limit", String(params.limit));
    }
    if (params.offset !== undefined) {
      qs.set("offset", String(params.offset));
    }
    if (params.status) {
      qs.set("status", params.status);
    }
    if (params.sortBy) {
      qs.set("sortBy", params.sortBy);
    }
    if (params.creator) {
      qs.set("creator", params.creator);
    }
    const tail = qs.toString();
    return this.get(`/api/runtime/rain/markets${tail ? `?${tail}` : ""}`);
  }

  async getMarket(marketId: string): Promise<unknown> {
    return this.get(`/api/runtime/rain/markets/${encodeURIComponent(marketId)}`);
  }

  async buildBuy(body: {
    marketContractAddress: string;
    selectedOption: number;
    buyAmountInWei: string;
  }): Promise<unknown> {
    return this.post("/api/runtime/rain/build-buy", body);
  }

  async buildClaim(body: { marketId: string; walletAddress: string }): Promise<unknown> {
    return this.post("/api/runtime/rain/build-claim", body);
  }

  async getMarketAddress(marketId: string): Promise<unknown> {
    return this.get(`/api/runtime/rain/markets/${encodeURIComponent(marketId)}/address`);
  }

  async resolveMarketId(address: string): Promise<unknown> {
    return this.get(`/api/runtime/rain/markets/address/${encodeURIComponent(address)}/id`);
  }

  async getConfig(): Promise<unknown> {
    return this.get("/api/runtime/rain/config");
  }

  async getHealth(): Promise<unknown> {
    return this.get("/api/runtime/rain/health");
  }

  async getTransactionDetails(txHash: string): Promise<unknown> {
    return this.get(`/api/runtime/rain/transactions/${encodeURIComponent(txHash)}`);
  }

  // ── Slice 3 — positions / portfolio / PnL ──────────────────────────────────

  async getPositions(walletAddress: string): Promise<unknown> {
    return this.get(
      `/api/runtime/rain/positions?walletAddress=${encodeURIComponent(walletAddress)}`,
    );
  }

  async getPositionByMarket(marketId: string, walletAddress: string): Promise<unknown> {
    return this.get(
      `/api/runtime/rain/positions/${encodeURIComponent(marketId)}?walletAddress=${encodeURIComponent(walletAddress)}`,
    );
  }

  async getLpPosition(marketId: string, walletAddress: string): Promise<unknown> {
    return this.get(
      `/api/runtime/rain/lp-position/${encodeURIComponent(marketId)}?walletAddress=${encodeURIComponent(walletAddress)}`,
    );
  }

  async getPortfolioValue(walletAddress: string, tokenAddresses: string[]): Promise<unknown> {
    const qs = new URLSearchParams({ walletAddress, tokenAddresses: tokenAddresses.join(",") });
    return this.get(`/api/runtime/rain/portfolio-value?${qs}`);
  }

  async getPnl(walletAddress: string, marketAddress?: string): Promise<unknown> {
    const qs = new URLSearchParams({ walletAddress });
    if (marketAddress) {
      qs.set("marketAddress", marketAddress);
    }
    return this.get(`/api/runtime/rain/pnl?${qs}`);
  }

  // ── Slice 4 — trade history + transactions + market activity ───────────────

  async getTradeHistory(walletAddress: string, marketAddress: string): Promise<unknown> {
    const qs = new URLSearchParams({ walletAddress, marketAddress });
    return this.get(`/api/runtime/rain/trade-history?${qs}`);
  }

  async getTransactions(
    walletAddress: string,
    params: { first?: number; skip?: number; orderDirection?: string } = {},
  ): Promise<unknown> {
    const qs = new URLSearchParams({ address: walletAddress });
    if (params.first !== undefined) {
      qs.set("first", String(params.first));
    }
    if (params.skip !== undefined) {
      qs.set("skip", String(params.skip));
    }
    if (params.orderDirection) {
      qs.set("orderDirection", params.orderDirection);
    }
    return this.get(`/api/runtime/rain/transactions?${qs}`);
  }

  async getMarketTransactions(
    marketAddress: string,
    params: { first?: number } = {},
  ): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params.first !== undefined) {
      qs.set("first", String(params.first));
    }
    const tail = qs.toString();
    return this.get(
      `/api/runtime/rain/market-transactions/${encodeURIComponent(marketAddress)}${tail ? `?${tail}` : ""}`,
    );
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return this.handleResponse(res);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.handleResponse(res);
  }

  private async handleResponse(res: Response): Promise<unknown> {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // Body wasn't JSON; payload stays null.
    }
    if (!res.ok) {
      const errPayload = (payload as RuntimeClientErrorPayload | null) ?? undefined;
      throw new RuntimeClientError(
        res.status,
        errPayload?.code,
        errPayload?.error ?? `Rain runtime HTTP ${res.status}`,
      );
    }
    return payload;
  }
}
