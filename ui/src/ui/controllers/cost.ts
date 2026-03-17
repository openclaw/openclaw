import type { GatewayBrowserClient } from "../gateway.ts";

export type CostSummaryResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  totals: {
    total: number;
    llm: number;
    fixed: number;
    oneOff: number;
    usage: number;
  };
  bySourceType: {
    llm: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      totalCost: number;
      inputCost: number;
      outputCost: number;
      cacheReadCost: number;
      cacheWriteCost: number;
      missingCostEntries: number;
    };
    fixed: number;
    oneOff: number;
    usage: number;
  };
};

export type CostTimeseriesResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  series: Array<{
    date: string;
    llm: number;
    fixed: number;
    oneOff: number;
    usage: number;
    total: number;
  }>;
};

export type ModelCostBreakdownResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  byProvider: Array<{
    provider: string;
    totalCost: number;
    totalTokens: number;
    models: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      totalCost: number;
      callCount: number;
    }>;
  }>;
};

export type TopSessionsResponse = {
  updatedAt: number;
  range: { startMs: number; endMs: number };
  sessions: Array<{
    key: string;
    sessionId: string;
    label?: string;
    agentId?: string;
    totalCost: number;
    totalTokens: number;
    firstActivity?: number;
    lastActivity?: number;
  }>;
};

export type LedgerItem = {
  id: string;
  name: string;
  vendor: string | null;
  category: string | null;
  costType: "fixed" | "usage" | "one_off";
  billingCycle: "monthly" | "annual" | null;
  amount: number;
  metricUnit: string | null;
  unitPrice: number | null;
  effectiveStart: number;
  effectiveEnd: number | null;
  notes: string | null;
  tags: string[];
  status: "active" | "inactive";
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type CostState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  startDate: string;
  endDate: string;
  summary: CostSummaryResponse | null;
  timeseries: CostTimeseriesResponse | null;
  byModel: ModelCostBreakdownResponse | null;
  topSessions: TopSessionsResponse | null;
  ledgerItems: LedgerItem[];
  ledgerLoading: boolean;
  activeTab: "overview" | "models" | "sessions" | "ledger";
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDefaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 29);
  return formatDate(date);
}

function getDefaultEndDate(): string {
  return formatDate(new Date());
}

export function createInitialCostState(): CostState {
  return {
    client: null,
    connected: false,
    loading: false,
    error: null,
    startDate: getDefaultStartDate(),
    endDate: getDefaultEndDate(),
    summary: null,
    timeseries: null,
    byModel: null,
    topSessions: null,
    ledgerItems: [],
    ledgerLoading: false,
    activeTab: "overview",
  };
}

export async function loadCostSummary(
  client: GatewayBrowserClient,
  startDate: string,
  endDate: string,
): Promise<CostSummaryResponse> {
  const result = await client.request<CostSummaryResponse>("cost.summary", {
    startDate,
    endDate,
  });
  return result;
}

export async function loadCostTimeseries(
  client: GatewayBrowserClient,
  startDate: string,
  endDate: string,
): Promise<CostTimeseriesResponse> {
  const result = await client.request<CostTimeseriesResponse>("cost.timeseries", {
    startDate,
    endDate,
  });
  return result;
}

export async function loadCostByModel(
  client: GatewayBrowserClient,
  startDate: string,
  endDate: string,
): Promise<ModelCostBreakdownResponse> {
  const result = await client.request<ModelCostBreakdownResponse>("cost.byModel", {
    startDate,
    endDate,
  });
  return result;
}

export async function loadTopSessions(
  client: GatewayBrowserClient,
  startDate: string,
  endDate: string,
  limit: number = 20,
): Promise<TopSessionsResponse> {
  const result = await client.request<TopSessionsResponse>("cost.topSessions", {
    startDate,
    endDate,
    limit,
  });
  return result;
}

export async function loadLedgerItems(client: GatewayBrowserClient): Promise<LedgerItem[]> {
  const result = await client.request<{ items: LedgerItem[] }>("cost.ledger.list", {});
  return result.items;
}

export async function upsertLedgerItem(
  client: GatewayBrowserClient,
  item: Partial<LedgerItem> & { name: string; costType: string; amount: number },
): Promise<string> {
  const result = await client.request<{ id: string }>("cost.ledger.upsert", item);
  return result.id;
}

export async function deleteLedgerItem(client: GatewayBrowserClient, id: string): Promise<void> {
  await client.request<{ id: string }>("cost.ledger.delete", { id });
}

export async function exportCostData(
  client: GatewayBrowserClient,
  startDate: string,
  endDate: string,
  format: "csv" | "json",
): Promise<string> {
  const result = await client.request<{ csv?: string; json?: unknown }>("cost.export", {
    startDate,
    endDate,
    format,
  });
  if (format === "csv" && result.csv) {
    return result.csv;
  }
  return JSON.stringify(result, null, 2);
}
