/**
 * Billing & Usage Types — Pure Usage-Based Model
 *
 * No plans. No tiers. Pay for what you use via prepaid credits.
 * Every LLM call, message, tool execution, and agent run is metered.
 */

import type { OrgId } from "../tenants/types.js";

// ── Billable Events ──────────────────────────────────────────────────────────

export const BILLABLE_EVENTS = [
	"llm_tokens_input",
	"llm_tokens_output",
	"message_sent",
	"tool_execution",
	"agent_run",
	"image_generated",
	"voice_minutes",
	"web_search",
	"cron_trigger",
	"file_processed",
] as const;
export type BillableEvent = (typeof BILLABLE_EVENTS)[number];

// ── Per-Unit Pricing (in fractional cents for precision) ─────────────────────

/** Price per unit in cents (e.g., 0.3 = $0.003 per unit) */
export const UNIT_PRICES: Record<BillableEvent, number> = {
	llm_tokens_input: 0.0003, // $0.003 per 1K tokens (price per token)
	llm_tokens_output: 0.0015, // $0.015 per 1K tokens
	message_sent: 1, // $0.01
	tool_execution: 2, // $0.02
	agent_run: 5, // $0.05
	image_generated: 5, // $0.05
	voice_minutes: 3, // $0.03
	web_search: 1, // $0.01
	cron_trigger: 1, // $0.01
	file_processed: 2, // $0.02
};

// ── Usage Event ──────────────────────────────────────────────────────────────

export interface UsageEvent {
	id: string;
	orgId: OrgId;
	event: BillableEvent;
	quantity: number;
	costCents: number;
	metadata: Record<string, string>;
	timestamp: Date;
}

// ── Usage Summary ────────────────────────────────────────────────────────────

export interface UsageSummary {
	orgId: OrgId;
	periodStart: Date;
	periodEnd: Date;
	totals: Partial<Record<BillableEvent, number>>;
	costBreakdown: CostLineItem[];
	totalCostCents: number;
}

export interface CostLineItem {
	event: BillableEvent;
	quantity: number;
	unitPriceCents: number;
	totalCents: number;
	description: string;
}

// ── Credit Types ─────────────────────────────────────────────────────────────

export interface CreditTransaction {
	id: string;
	orgId: OrgId;
	amountCents: number;
	type: "credit" | "debit";
	source: "stripe" | "manual" | "auto_topup" | "usage";
	description: string;
	relatedEventId?: string;
	timestamp: Date;
}

export interface CreditBalance {
	orgId: OrgId;
	balanceCents: number;
	lastUpdated: Date;
}

export interface AutoTopUpConfig {
	enabled: boolean;
	thresholdCents: number;
	topUpAmountCents: number;
	stripePaymentMethodId: string;
}

// ── Stripe Types ─────────────────────────────────────────────────────────────

export interface StripeConfig {
	secretKey: string;
	webhookSecret: string;
}
