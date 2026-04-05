/**
 * Usage Metering Engine — Credit-Based
 *
 * Records every billable event and deducts from org credit balance.
 * No quotas, no plans — pure pay-per-use.
 */

import crypto from "node:crypto";
import { getOrg } from "../tenants/tenant-store.js";
import type { OrgId } from "../tenants/types.js";
import { deductCredits, getBalance } from "./credits.js";
import type { BillableEvent, CostLineItem, UsageEvent, UsageSummary } from "./types.js";
import { UNIT_PRICES } from "./types.js";

// ── In-Memory Usage Store ────────────────────────────────────────────────────

const usageLog: UsageEvent[] = [];

// ── Record Usage ─────────────────────────────────────────────────────────────

export interface RecordResult {
  recorded: boolean;
  costCents: number;
  creditsRemaining: number;
  insufficientCredits: boolean;
  event: BillableEvent;
}

/**
 * Record a billable event and deduct credits.
 * Returns whether credits were sufficient to cover the cost.
 */
export function recordUsage(
  orgId: OrgId,
  event: BillableEvent,
  quantity: number,
  metadata: Record<string, string> = {},
): RecordResult {
  const org = getOrg(orgId);
  if (!org) {
    throw new Error(`Org ${orgId} not found`);
  }

  const costCents = Math.round(quantity * UNIT_PRICES[event] * 100) / 100;

  const usageEvent: UsageEvent = {
    id: crypto.randomBytes(16).toString("hex"),
    orgId,
    event,
    quantity,
    costCents,
    metadata,
    timestamp: new Date(),
  };
  usageLog.push(usageEvent);

  // Deduct from credit balance
  const deduction = deductCredits(orgId, costCents, event, metadata);

  return {
    recorded: true,
    costCents,
    creditsRemaining: deduction.remaining,
    insufficientCredits: !deduction.success,
    event,
  };
}

// ── Pre-Execution Credit Check ───────────────────────────────────────────────

/** Check if org has enough credits before executing an agent run */
export function canAffordExecution(orgId: OrgId, estimatedCostCents: number): boolean {
  const balance = getBalance(orgId);
  return balance.balanceCents >= estimatedCostCents;
}

/** Estimate cost for an agent run (rough: tokens + tools + message) */
export function estimateAgentRunCost(params: {
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedToolCalls?: number;
  willSendMessage?: boolean;
}): number {
  let cost = UNIT_PRICES.agent_run; // base agent run cost
  if (params.estimatedInputTokens) {
    cost += params.estimatedInputTokens * UNIT_PRICES.llm_tokens_input;
  }
  if (params.estimatedOutputTokens) {
    cost += params.estimatedOutputTokens * UNIT_PRICES.llm_tokens_output;
  }
  if (params.estimatedToolCalls) {
    cost += params.estimatedToolCalls * UNIT_PRICES.tool_execution;
  }
  if (params.willSendMessage) {
    cost += UNIT_PRICES.message_sent;
  }

  return Math.round(cost * 100) / 100;
}

// ── Usage Queries ────────────────────────────────────────────────────────────

export function getCurrentPeriodUsage(orgId: OrgId, event: BillableEvent): number {
  const periodStart = getCurrentPeriodStart();
  return usageLog
    .filter((e) => e.orgId === orgId && e.event === event && e.timestamp >= periodStart)
    .reduce((sum, e) => sum + e.quantity, 0);
}

function getCurrentPeriodStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function getUsageSummary(orgId: OrgId): UsageSummary {
  const org = getOrg(orgId);
  if (!org) {
    throw new Error(`Org ${orgId} not found`);
  }

  const periodStart = getCurrentPeriodStart();
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);

  const periodEvents = usageLog.filter(
    (e) => e.orgId === orgId && e.timestamp >= periodStart && e.timestamp < periodEnd,
  );

  const totals: Record<string, number> = {};
  for (const e of periodEvents) {
    totals[e.event] = (totals[e.event] ?? 0) + e.quantity;
  }

  const costBreakdown: CostLineItem[] = Object.entries(totals).map(([event, quantity]) => {
    const unitPrice = UNIT_PRICES[event as BillableEvent] ?? 0;
    return {
      event: event as BillableEvent,
      quantity,
      unitPriceCents: unitPrice,
      totalCents: Math.round(quantity * unitPrice * 100) / 100,
      description: `${quantity} ${event.replace(/_/g, " ")}`,
    };
  });

  const totalCostCents = costBreakdown.reduce((sum, item) => sum + item.totalCents, 0);

  return {
    orgId,
    periodStart,
    periodEnd,
    totals: totals as Partial<Record<BillableEvent, number>>,
    costBreakdown,
    totalCostCents,
  };
}

/** Daily usage time series for dashboard charts */
export function getDailyUsage(
  orgId: OrgId,
  days: number = 30,
): { date: string; costCents: number; events: number }[] {
  const result: { date: string; costCents: number; events: number }[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayEnd = new Date(day.getTime() + 86_400_000);
    const dayStr = day.toISOString().slice(0, 10);

    const dayEvents = usageLog.filter(
      (e) => e.orgId === orgId && e.timestamp >= day && e.timestamp < dayEnd,
    );

    result.push({
      date: dayStr,
      costCents: dayEvents.reduce((sum, e) => sum + e.costCents, 0),
      events: dayEvents.length,
    });
  }

  return result;
}

/** Total revenue across all orgs (platform admin metric) */
export function getPlatformRevenue(): { totalCents: number; eventCount: number; orgCount: number } {
  const orgSet = new Set<string>();
  let totalCents = 0;
  for (const e of usageLog) {
    totalCents += e.costCents;
    orgSet.add(e.orgId);
  }
  return { totalCents, eventCount: usageLog.length, orgCount: orgSet.size };
}
