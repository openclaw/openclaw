import type { UsageSessionEntry, UsageTotals } from "./types.ts";

export const chartTotals = {
  input: 1_200_000,
  output: 300_000,
  cacheRead: 2_400_000,
  cacheWrite: 100_000,
  totalTokens: 4_000_000,
  totalCost: 32,
  inputCost: 12,
  outputCost: 12,
  cacheReadCost: 6,
  cacheWriteCost: 2,
  missingCostEntries: 0,
};

export const emptyTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

export function dayOffset(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dailyEntry(offset: number, totalCost: number, totalTokens: number) {
  return {
    ...chartTotals,
    date: dayOffset(offset),
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
}

export function emptyUsageResponses() {
  const updatedAt = Date.now();
  const date = dayOffset(0);
  return {
    "sessions.usage": {
      updatedAt,
      startDate: date,
      endDate: date,
      sessions: [],
      totals: emptyTotals,
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
    },
    "usage.cost": { updatedAt, days: 1, daily: [], totals: emptyTotals },
  };
}

export const zeroCost = {
  input: 1_000,
  output: 500,
  cacheRead: 200,
  cacheWrite: 0,
  totalTokens: 1_700,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
} satisfies UsageTotals;

export function usageSession(
  key: string,
  agentId: string,
  provider: string,
  totalsOverrides: Partial<UsageTotals> = {},
): UsageSessionEntry {
  const totals: UsageTotals = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    totalCost: 1,
    inputCost: 0.8,
    outputCost: 0.2,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...totalsOverrides,
  };
  return {
    key,
    label: `${agentId} session`,
    agentId,
    modelProvider: provider,
    model: `${provider}-model`,
    updatedAt: Date.now(),
    usage: {
      ...totals,
      messageCounts: {
        total: 2,
        user: 1,
        assistant: 1,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      modelUsage: [{ provider, model: `${provider}-model`, count: 1, totals }],
    },
  };
}

export function createUsageDailyEntries() {
  return [
    dailyEntry(-89, 5, 500_000),
    dailyEntry(-29, 7, 700_000),
    dailyEntry(-6, 9, 900_000),
    dailyEntry(0, 11, 1_100_000),
  ];
}

export function createRecordedCostResponses(
  updatedAt: number,
  date: string,
  empty: ReturnType<typeof emptyUsageResponses>,
) {
  const knownTotals = { ...zeroCost };
  const messages = { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 };
  const sessions = [
    { label: "Known zero", totalCost: 0, missingCostEntries: 0 },
    { label: "Known positive", totalCost: 0.2, missingCostEntries: 0 },
    { label: "Unpriced usage", totalCost: 0, missingCostEntries: 1 },
  ].map(({ label, totalCost, missingCostEntries }, index) => ({
    key: `agent:main:cost-hint-${index}`,
    label,
    agentId: "main",
    updatedAt,
    usage: {
      ...knownTotals,
      totalCost,
      inputCost: totalCost,
      missingCostEntries,
      activityDates: [date],
      firstActivity: updatedAt - 1_000,
      lastActivity: updatedAt,
      durationMs: 1_000,
      messageCounts: messages,
    },
  }));
  const combined = {
    ...knownTotals,
    input: 3_000,
    output: 1_500,
    cacheRead: 600,
    totalTokens: 5_100,
    totalCost: 0.2,
    inputCost: 0.2,
    missingCostEntries: 1,
  };
  const responses = {
    "sessions.usage": {
      ...empty["sessions.usage"],
      updatedAt,
      sessions,
      totals: combined,
      aggregates: {
        ...empty["sessions.usage"].aggregates,
        messages: { ...messages, total: 6, user: 3, assistant: 3 },
      },
    },
    "usage.cost": { updatedAt, days: 1, daily: [{ date, ...combined }], totals: combined },
    "usage.status": { updatedAt, providers: [] },
  };
  return responses;
}

export function createCostAnalysisResponses(daily: ReturnType<typeof createUsageDailyEntries>) {
  return {
    "agents.list": {
      agents: [
        { id: "main", name: "Main" },
        { id: "writer", name: "Writer" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    },
    "sessions.usage": {
      updatedAt: Date.now(),
      startDate: dayOffset(-89),
      endDate: dayOffset(0),
      sessions: [
        {
          key: "agent:main:cost-analysis",
          label: "Cost analysis",
          agentId: "main",
          modelProvider: "openai",
          model: "gpt-5.5",
          updatedAt: Date.now(),
          usage: {
            ...chartTotals,
            activityDates: daily.map((entry) => entry.date),
            dailyBreakdown: daily.map((entry) => ({
              ...entry,
              cost: entry.totalCost,
              tokens: entry.totalTokens,
            })),
            messageCounts: {
              total: 40,
              user: 20,
              assistant: 20,
              toolCalls: 12,
              toolResults: 12,
              errors: 0,
            },
            modelUsage: [
              {
                provider: "openai",
                model: "gpt-5.5",
                count: 30,
                totals: { ...chartTotals, totalCost: 22 },
              },
              {
                provider: "anthropic",
                model: "claude-opus-4-6",
                count: 10,
                totals: { ...chartTotals, totalCost: 10 },
              },
            ],
          },
        },
      ],
      totals: chartTotals,
      aggregates: {
        messages: {
          total: 40,
          user: 20,
          assistant: 20,
          toolCalls: 12,
          toolResults: 12,
          errors: 0,
        },
        tools: { totalCalls: 12, uniqueTools: 2, tools: [{ name: "exec", count: 8 }] },
        byModel: [
          {
            provider: "openai",
            model: "gpt-5.5",
            count: 30,
            totals: { ...chartTotals, totalCost: 22 },
          },
          {
            provider: "anthropic",
            model: "claude-opus-4-6",
            count: 10,
            totals: { ...chartTotals, totalCost: 10 },
          },
        ],
        byProvider: [
          { provider: "openai", count: 30, totals: { ...chartTotals, totalCost: 22 } },
          { provider: "anthropic", count: 10, totals: { ...chartTotals, totalCost: 10 } },
        ],
        byAgent: [{ agentId: "main", totals: chartTotals }],
        byChannel: [],
        daily: daily.map((entry) => ({
          date: entry.date,
          tokens: entry.totalTokens,
          cost: entry.totalCost,
          messages: 10,
          toolCalls: 3,
          errors: 0,
        })),
      },
    },
    "usage.cost": {
      updatedAt: Date.now(),
      days: 90,
      daily,
      totals: chartTotals,
    },
    "usage.status": {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          plan: "Admin API",
          windows: [],
          billing: [{ type: "spend", label: "30-day API spend", amount: 98.75, unit: "USD" }],
          costHistory: {
            unit: "USD",
            periodDays: 30,
            daily: [
              {
                date: dayOffset(-6),
                amount: 38.5,
                requests: 12_300,
                inputTokens: 4_200_000,
                cacheReadTokens: 2_100_000,
                cacheWriteTokens: 0,
                outputTokens: 850_000,
                totalTokens: 5_050_000,
              },
              {
                date: dayOffset(0),
                amount: 60.25,
                requests: 18_450,
                inputTokens: 6_100_000,
                cacheReadTokens: 3_400_000,
                cacheWriteTokens: 0,
                outputTokens: 1_200_000,
                totalTokens: 7_300_000,
              },
            ],
            models: [
              {
                name: "gpt-5.5",
                requests: 30_750,
                inputTokens: 10_300_000,
                cacheReadTokens: 5_500_000,
                cacheWriteTokens: 0,
                outputTokens: 2_050_000,
                totalTokens: 12_350_000,
              },
            ],
            categories: [{ name: "Responses", amount: 98.75 }],
          },
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          plan: "Admin API",
          windows: [],
          billing: [{ type: "spend", label: "30-day API spend", amount: 42.4, unit: "USD" }],
          costHistory: {
            unit: "USD",
            periodDays: 30,
            daily: [
              {
                date: dayOffset(-6),
                amount: 17.15,
                inputTokens: 1_800_000,
                cacheReadTokens: 900_000,
                cacheWriteTokens: 200_000,
                outputTokens: 350_000,
                totalTokens: 3_250_000,
              },
              {
                date: dayOffset(0),
                amount: 25.25,
                inputTokens: 2_600_000,
                cacheReadTokens: 1_400_000,
                cacheWriteTokens: 300_000,
                outputTokens: 500_000,
                totalTokens: 4_800_000,
              },
            ],
            models: [
              {
                name: "claude-opus-4-8",
                inputTokens: 4_400_000,
                cacheReadTokens: 2_300_000,
                cacheWriteTokens: 500_000,
                outputTokens: 850_000,
                totalTokens: 8_050_000,
              },
            ],
            categories: [{ name: "Claude API", amount: 42.4 }],
          },
        },
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          plan: "Production",
          windows: [{ label: "API key budget", usedPercent: 25 }],
          billing: [
            {
              type: "balance",
              label: "Account balance",
              amount: 64.5,
              unit: "USD",
            },
            {
              type: "budget",
              label: "API key budget",
              used: 5,
              limit: 20,
              unit: "USD",
            },
          ],
          summary: "$1.25 today · $5.00 this month",
        },
      ],
    },
  };
}
