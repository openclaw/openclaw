/**
 * Enterprise REST API Router
 *
 * HTTP handler matching the gateway's raw IncomingMessage/ServerResponse pattern.
 * Handles billing, usage, dashboard — agent CRUD happens via the Master Agent chat.
 *
 * All endpoints require Bearer token auth via API keys.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrgId, UserId } from "../tenants/types.js";
import { createOrg, createApiKey, resolveApiKey, getOrg, listOrgs } from "../tenants/tenant-store.js";
import {
	addCredits,
	getBalance,
	getAutoTopUp,
	setAutoTopUp,
	getTransactionHistory,
	MINIMUM_PURCHASE_CENTS,
} from "../billing/credits.js";
import { getUsageSummary, getDailyUsage, getPlatformRevenue } from "../billing/usage-meter.js";
import { listOrgAgents, getAgentStatus, getAllActiveAgents } from "../orchestrator/agent-spawner.js";
import type { AutoTopUpConfig } from "../billing/types.js";
import {
	startFormation,
	getFormationStatus,
	listOrgEntities,
	estimateFormationCost,
	getUpcomingCompliance,
} from "../formation/formation-engine.js";
import type { EntityType, USState } from "../formation/types.js";
import {
	getBusinessHealth,
	getRevenueSummary,
	getDailyRevenue,
	listClients,
	listDeals,
	listInvoices,
	getPipelineValue,
	getAgentRevenue,
} from "../revenue/revenue-engine.js";

// ── HTTP Helpers ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
	sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf-8");
				resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function getBearerToken(req: IncomingMessage): string | null {
	const auth = req.headers.authorization;
	if (!auth?.startsWith("Bearer ")) return null;
	return auth.slice(7).trim();
}

// ── Auth Middleware ───────────────────────────────────────────────────────────

interface AuthContext {
	orgId: OrgId;
}

function authenticate(req: IncomingMessage): AuthContext | null {
	const token = getBearerToken(req);
	if (!token) return null;

	const apiKey = resolveApiKey(token);
	if (!apiKey) return null;

	return { orgId: apiKey.orgId };
}

// ── Route Matching ───────────────────────────────────────────────────────────

type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
	pathParams: Record<string, string>,
) => Promise<void>;

interface Route {
	method: string;
	pattern: RegExp;
	paramNames: string[];
	handler: RouteHandler;
	requiresAuth: boolean;
}

const routes: Route[] = [];

function route(
	method: string,
	path: string,
	handler: RouteHandler,
	requiresAuth: boolean = true,
): void {
	const paramNames: string[] = [];
	const patternStr = path.replace(/:(\w+)/g, (_, name) => {
		paramNames.push(name);
		return "([^/]+)";
	});
	routes.push({
		method,
		pattern: new RegExp(`^${patternStr}$`),
		paramNames,
		handler,
		requiresAuth,
	});
}

// ── Route Definitions ────────────────────────────────────────────────────────

// Public: signup
route("POST", "/enterprise/signup", handleSignup, false);

// Credits
route("POST", "/enterprise/credits/add", handleAddCredits);
route("GET", "/enterprise/credits/balance", handleGetBalance);
route("POST", "/enterprise/credits/auto-topup", handleSetAutoTopUp);
route("GET", "/enterprise/credits/transactions", handleGetTransactions);

// Agents (read-only — CRUD via Master Agent chat)
route("GET", "/enterprise/agents", handleListAgents);
route("GET", "/enterprise/agents/:id/metrics", handleGetAgentMetrics);

// Usage
route("GET", "/enterprise/usage", handleGetUsage);
route("GET", "/enterprise/usage/daily", handleGetDailyUsage);

// Dashboard (platform admin)
route("GET", "/enterprise/dashboard", handleDashboard);

// Business Formation
route("POST", "/enterprise/formation/estimate", handleFormationEstimate);
route("POST", "/enterprise/formation/start", handleStartFormation);
route("GET", "/enterprise/formation/:id", handleFormationStatus);
route("GET", "/enterprise/entities", handleListEntities);
route("GET", "/enterprise/compliance/upcoming", handleUpcomingCompliance);

// Revenue & Business
route("GET", "/enterprise/revenue", handleGetRevenue);
route("GET", "/enterprise/revenue/daily", handleGetDailyRevenue);
route("GET", "/enterprise/business/health", handleBusinessHealth);
route("GET", "/enterprise/clients", handleListClients);
route("GET", "/enterprise/deals", handleListDeals);
route("GET", "/enterprise/deals/pipeline", handlePipelineValue);
route("GET", "/enterprise/invoices", handleListInvoices);
route("GET", "/enterprise/agents/:id/revenue", handleAgentRevenue);

// Stripe webhooks
route("POST", "/enterprise/webhooks/stripe", handleStripeWebhook, false);

// ── Main Router ──────────────────────────────────────────────────────────────

export async function handleEnterpriseRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;

	if (!pathname.startsWith("/enterprise")) return false;

	const method = req.method?.toUpperCase() ?? "GET";

	for (const r of routes) {
		if (r.method !== method) continue;
		const match = pathname.match(r.pattern);
		if (!match) continue;

		const pathParams: Record<string, string> = {};
		for (let i = 0; i < r.paramNames.length; i++) {
			pathParams[r.paramNames[i]] = match[i + 1];
		}

		const auth = authenticate(req);
		if (r.requiresAuth && !auth) {
			sendError(res, 401, "Unauthorized: valid API key required");
			return true;
		}

		try {
			await r.handler(req, res, auth, pathParams);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Internal server error";
			sendError(res, 500, message);
		}
		return true;
	}

	sendError(res, 404, "Not found");
	return true;
}

// ── Handler Implementations ──────────────────────────────────────────────────

async function handleSignup(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = await readBody(req);
	const name = body.name as string;
	const slug = body.slug as string;

	if (!name || !slug) {
		sendError(res, 400, "name and slug are required");
		return;
	}

	const userId = `user_${Date.now().toString(36)}` as UserId;
	const org = createOrg({ name, slug, ownerId: userId });
	const { apiKey, rawKey } = createApiKey({ orgId: org.id, name: "Default API Key" });

	sendJson(res, 201, {
		org: { id: org.id, name: org.name, slug: org.slug },
		apiKey: {
			id: apiKey.id,
			key: rawKey,
			prefix: apiKey.keyPrefix,
		},
		message: "Organization created. Save your API key — it won't be shown again.",
	});
}

async function handleAddCredits(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const body = await readBody(req);
	const amountCents = body.amount_cents as number;

	if (!amountCents || amountCents < MINIMUM_PURCHASE_CENTS) {
		sendError(res, 400, `Minimum purchase is $${(MINIMUM_PURCHASE_CENTS / 100).toFixed(2)}`);
		return;
	}

	// In production: create Stripe checkout session first, then add credits on webhook
	// For now: direct credit addition
	const result = addCredits(auth.orgId, amountCents, "manual", `Manual credit purchase`);
	sendJson(res, 200, {
		balance_cents: result.balanceCents,
		transaction_id: result.transactionId,
	});
}

async function handleGetBalance(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const balance = getBalance(auth.orgId);
	const autoTopUp = getAutoTopUp(auth.orgId);

	sendJson(res, 200, {
		balance_cents: balance.balanceCents,
		low_balance: balance.lowBalance,
		can_execute: balance.canExecute,
		auto_topup: autoTopUp ?? null,
	});
}

async function handleSetAutoTopUp(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const body = await readBody(req);
	const config: AutoTopUpConfig = {
		enabled: body.enabled as boolean,
		thresholdCents: (body.threshold_cents as number) ?? 500,
		topUpAmountCents: (body.topup_amount_cents as number) ?? 2000,
		stripePaymentMethodId: (body.payment_method_id as string) ?? "",
	};
	setAutoTopUp(auth.orgId, config);
	sendJson(res, 200, { auto_topup: config });
}

async function handleGetTransactions(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const transactions = getTransactionHistory(auth.orgId, 100);
	sendJson(res, 200, { transactions });
}

async function handleListAgents(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const agents = listOrgAgents(auth.orgId);
	sendJson(res, 200, {
		agents: agents.map((a) => ({
			id: a.id,
			name: a.name,
			status: a.status,
			purpose: a.spec.purpose,
			channels: a.spec.channels,
			cron_schedule: a.spec.cronSchedule ?? null,
			metrics: a.metrics,
			created_at: a.createdAt.toISOString(),
		})),
	});
}

async function handleGetAgentMetrics(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
	pathParams: Record<string, string>,
): Promise<void> {
	if (!auth) return;
	const agent = getAgentStatus(pathParams.id);
	if (!agent || agent.orgId !== auth.orgId) {
		sendError(res, 404, "Agent not found");
		return;
	}
	sendJson(res, 200, {
		agent: {
			id: agent.id,
			name: agent.name,
			status: agent.status,
			spec: agent.spec,
			metrics: agent.metrics,
			cron_job_id: agent.cronJobId,
			created_at: agent.createdAt.toISOString(),
			updated_at: agent.updatedAt.toISOString(),
		},
	});
}

async function handleGetUsage(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const summary = getUsageSummary(auth.orgId);
	sendJson(res, 200, { usage: summary });
}

async function handleGetDailyUsage(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
	const daily = getDailyUsage(auth.orgId, Math.min(days, 90));
	sendJson(res, 200, { daily });
}

async function handleDashboard(
	_req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const revenue = getPlatformRevenue();
	const allOrgs = listOrgs();
	const allAgents = getAllActiveAgents();

	sendJson(res, 200, {
		platform: {
			total_revenue_cents: revenue.totalCents,
			total_events: revenue.eventCount,
			active_orgs: revenue.orgCount,
			total_orgs: allOrgs.length,
			active_agents: allAgents.length,
		},
		orgs: allOrgs.map((org) => ({
			id: org.id,
			name: org.name,
			agents: listOrgAgents(org.id).length,
			balance: getBalance(org.id),
		})),
	});
}

async function handleStripeWebhook(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = await readBody(req);
	const eventType = body.type as string;

	// In production: verify Stripe signature, then process
	switch (eventType) {
		case "checkout.session.completed": {
			// Extract orgId and amount from metadata, add credits
			const metadata = (body.data as Record<string, unknown>)?.metadata as
				| Record<string, string>
				| undefined;
			if (metadata?.orgId && metadata?.amountCents) {
				addCredits(
					metadata.orgId as OrgId,
					Number(metadata.amountCents),
					"stripe",
					"Stripe credit purchase",
				);
			}
			break;
		}
		case "payment_intent.succeeded": {
			// Auto-top-up payment succeeded
			break;
		}
		default:
			break;
	}

	sendJson(res, 200, { received: true });
}

// ── Formation Handlers ───────────────────────────────────────────────────────

async function handleFormationEstimate(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const body = await readBody(req);
	const estimate = estimateFormationCost(
		body.entity_type as EntityType,
		body.state as USState,
		{
			registeredAgent: (body.registered_agent as boolean) ?? true,
			bankAccount: (body.bank_account as boolean) ?? false,
			einApplication: (body.ein as boolean) ?? true,
		},
	);
	sendJson(res, 200, { estimate });
}

async function handleStartFormation(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const body = await readBody(req);

	const entity = startFormation(auth.orgId, {
		businessPurpose: body.business_purpose as string,
		entityType: body.entity_type as EntityType,
		state: body.state as USState,
		companyName: body.company_name as string,
		alternateNames: body.alternate_names as string[] | undefined,
		registeredAgentService: (body.registered_agent_service as "included" | "own") ?? "included",
		principalAddress: body.principal_address as any,
		members: body.members as any[],
		requestEin: (body.request_ein as boolean) ?? true,
		openBankAccount: (body.open_bank_account as boolean) ?? false,
		bankProvider: body.bank_provider as any,
	});

	sendJson(res, 201, { entity });
}

async function handleFormationStatus(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
	pathParams: Record<string, string>,
): Promise<void> {
	if (!auth) return;
	const entity = getFormationStatus(pathParams.id);
	if (!entity || entity.orgId !== auth.orgId) {
		sendError(res, 404, "Entity not found");
		return;
	}
	sendJson(res, 200, { entity });
}

async function handleListEntities(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { entities: listOrgEntities(auth.orgId) });
}

async function handleUpcomingCompliance(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
	sendJson(res, 200, { events: getUpcomingCompliance(auth.orgId, days) });
}

// ── Revenue & Business Handlers ──────────────────────────────────────────────

async function handleGetRevenue(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
	sendJson(res, 200, { revenue: getRevenueSummary(auth.orgId, days) });
}

async function handleGetDailyRevenue(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
	sendJson(res, 200, { daily: getDailyRevenue(auth.orgId, Math.min(days, 90)) });
}

async function handleBusinessHealth(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { health: getBusinessHealth(auth.orgId) });
}

async function handleListClients(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { clients: listClients(auth.orgId) });
}

async function handleListDeals(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { deals: listDeals(auth.orgId) });
}

async function handlePipelineValue(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { pipeline: getPipelineValue(auth.orgId) });
}

async function handleListInvoices(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
): Promise<void> {
	if (!auth) return;
	sendJson(res, 200, { invoices: listInvoices(auth.orgId) });
}

async function handleAgentRevenue(
	_req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext | null,
	pathParams: Record<string, string>,
): Promise<void> {
	if (!auth) return;
	const agent = getAgentStatus(pathParams.id);
	if (!agent || agent.orgId !== auth.orgId) {
		sendError(res, 404, "Agent not found");
		return;
	}
	sendJson(res, 200, { revenue: getAgentRevenue(pathParams.id) });
}
