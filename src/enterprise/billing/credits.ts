/**
 * Credit Balance System
 *
 * Prepaid credits model. Users load credits via Stripe, agents consume them.
 * When balance hits zero, agents pause. Auto-top-up keeps things running.
 */

import crypto from "node:crypto";
import type { OrgId } from "../tenants/types.js";
import type { AutoTopUpConfig, BillableEvent, CreditBalance, CreditTransaction } from "./types.js";

// ── In-Memory Store ──────────────────────────────────────────────────────────

const balances = new Map<OrgId, CreditBalance>();
const transactions: CreditTransaction[] = [];
const autoTopUpConfigs = new Map<OrgId, AutoTopUpConfig>();

const LOW_BALANCE_THRESHOLD_CENTS = 500; // $5 — warn when below this
const MINIMUM_PURCHASE_CENTS = 1000; // $10 minimum credit purchase

// ── Credit Operations ────────────────────────────────────────────────────────

export function addCredits(
	orgId: OrgId,
	amountCents: number,
	source: CreditTransaction["source"],
	description?: string,
): { balanceCents: number; transactionId: string } {
	if (amountCents <= 0) throw new Error("Amount must be positive");

	const balance = getOrCreateBalance(orgId);
	balance.balanceCents += amountCents;
	balance.lastUpdated = new Date();

	const tx: CreditTransaction = {
		id: crypto.randomBytes(16).toString("hex"),
		orgId,
		amountCents,
		type: "credit",
		source,
		description: description ?? `Added ${formatCents(amountCents)} credits`,
		timestamp: new Date(),
	};
	transactions.push(tx);

	return { balanceCents: balance.balanceCents, transactionId: tx.id };
}

export function deductCredits(
	orgId: OrgId,
	amountCents: number,
	event: BillableEvent,
	metadata: Record<string, string> = {},
): { success: boolean; remaining: number; transactionId: string } {
	const balance = getOrCreateBalance(orgId);
	const willGoNegative = balance.balanceCents < amountCents;

	// Always deduct (allow slight negative for in-flight runs)
	balance.balanceCents -= amountCents;
	balance.lastUpdated = new Date();

	const tx: CreditTransaction = {
		id: crypto.randomBytes(16).toString("hex"),
		orgId,
		amountCents,
		type: "debit",
		source: "usage",
		description: `${event}: ${JSON.stringify(metadata)}`,
		relatedEventId: metadata.eventId,
		timestamp: new Date(),
	};
	transactions.push(tx);

	// Check if auto-top-up should trigger
	if (balance.balanceCents < (autoTopUpConfigs.get(orgId)?.thresholdCents ?? 0)) {
		triggerAutoTopUp(orgId);
	}

	return {
		success: !willGoNegative,
		remaining: balance.balanceCents,
		transactionId: tx.id,
	};
}

export function getBalance(orgId: OrgId): {
	balanceCents: number;
	lowBalance: boolean;
	canExecute: boolean;
} {
	const balance = getOrCreateBalance(orgId);
	return {
		balanceCents: balance.balanceCents,
		lowBalance: balance.balanceCents < LOW_BALANCE_THRESHOLD_CENTS,
		canExecute: balance.balanceCents > 0,
	};
}

export function hasCredits(orgId: OrgId, estimatedCostCents: number): boolean {
	const balance = getOrCreateBalance(orgId);
	return balance.balanceCents >= estimatedCostCents;
}

// ── Auto Top-Up ──────────────────────────────────────────────────────────────

export function setAutoTopUp(orgId: OrgId, config: AutoTopUpConfig): void {
	autoTopUpConfigs.set(orgId, config);
}

export function getAutoTopUp(orgId: OrgId): AutoTopUpConfig | undefined {
	return autoTopUpConfigs.get(orgId);
}

/** Triggered internally when balance drops below threshold */
function triggerAutoTopUp(orgId: OrgId): void {
	const config = autoTopUpConfigs.get(orgId);
	if (!config?.enabled) return;

	// In production, this calls Stripe to charge the saved payment method.
	// For now, we emit an event that the Stripe integration layer handles.
	autoTopUpQueue.push({ orgId, amountCents: config.topUpAmountCents, timestamp: new Date() });
}

/** Queue of pending auto-top-ups for the Stripe integration to process */
export const autoTopUpQueue: { orgId: OrgId; amountCents: number; timestamp: Date }[] = [];

// ── Transaction History ──────────────────────────────────────────────────────

export function getTransactionHistory(
	orgId: OrgId,
	limit: number = 50,
): CreditTransaction[] {
	return transactions
		.filter((tx) => tx.orgId === orgId)
		.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
		.slice(0, limit);
}

export function getTotalSpent(orgId: OrgId): number {
	return transactions
		.filter((tx) => tx.orgId === orgId && tx.type === "debit")
		.reduce((sum, tx) => sum + tx.amountCents, 0);
}

export function getTotalDeposited(orgId: OrgId): number {
	return transactions
		.filter((tx) => tx.orgId === orgId && tx.type === "credit")
		.reduce((sum, tx) => sum + tx.amountCents, 0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateBalance(orgId: OrgId): CreditBalance {
	let balance = balances.get(orgId);
	if (!balance) {
		balance = { orgId, balanceCents: 0, lastUpdated: new Date() };
		balances.set(orgId, balance);
	}
	return balance;
}

function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

export { MINIMUM_PURCHASE_CENTS, LOW_BALANCE_THRESHOLD_CENTS };
