/**
 * Enterprise Agentic OS — Entry Point
 *
 * The full enterprise layer that turns OpenClaw into an autonomous
 * business-running platform. One master agent, dynamic sub-agents,
 * usage-based billing, and credit-based monetization.
 *
 * ## Architecture
 *
 * User ↔ Master Agent (via any channel)
 *   ↓ creates/manages
 * Sub-Agents (dynamic, per-org)
 *   ↓ runs via
 * OpenClaw Core (ACP + CronService + Channels + Providers)
 *   ↓ metered by
 * Usage Meter → Credit Balance → Stripe
 *
 * ## Integration Points
 *
 * - Gateway HTTP: Enterprise API routes attached to existing server
 * - CronService: Agent schedules registered via CronService.add()
 * - ACP: Agent execution via existing Agent Control Plane
 * - Outbound: Message delivery via deliverOutboundPayloads()
 * - Cost tracking: Extended from session-cost-usage patterns
 */

// ── Tenants ──────────────────────────────────────────────────────────────────
export {
	createOrg,
	getOrg,
	listOrgs,
	createTeam,
	addTeamMember,
	createApiKey,
	resolveApiKey,
	resolveTenantContext,
	hasPermission,
} from "./tenants/tenant-store.js";
export type {
	Organization,
	Team,
	TeamMember,
	ApiKey,
	TenantContext,
	OrgId,
	TeamId,
	UserId,
	Role,
	Permission,
} from "./tenants/types.js";

// ── Billing ──────────────────────────────────────────────────────────────────
export type { BillableEvent, UsageEvent, UsageSummary, CreditTransaction } from "./billing/types.js";
export { UNIT_PRICES } from "./billing/types.js";
export {
	recordUsage,
	canAffordExecution,
	estimateAgentRunCost,
	getUsageSummary,
	getDailyUsage,
	getPlatformRevenue,
} from "./billing/usage-meter.js";

// ── Credits ──────────────────────────────────────────────────────────────────
export {
	addCredits,
	deductCredits,
	getBalance,
	hasCredits,
	setAutoTopUp,
	getTransactionHistory,
} from "./billing/credits.js";

// ── Stripe ───────────────────────────────────────────────────────────────────
export {
	createCreditsPurchaseSession,
	processAutoTopUpQueue,
	handleStripeEvent,
} from "./billing/stripe-credits.js";

// ── Master Agent ─────────────────────────────────────────────────────────────
export {
	MASTER_AGENT_SYSTEM_PROMPT,
	MASTER_AGENT_TOOLS,
} from "./orchestrator/master-agent.js";

// ── Agent Spawner ────────────────────────────────────────────────────────────
export type { AgentSpec, DeployedAgent, AgentRunResult } from "./orchestrator/agent-spawner.js";
export {
	spawnAgent,
	destroyAgent,
	modifyAgent,
	executeAgentRun,
	listOrgAgents,
	getAgentStatus,
	getAllActiveAgents,
} from "./orchestrator/agent-spawner.js";

// ── Enterprise API ───────────────────────────────────────────────────────────
export { handleEnterpriseRequest } from "./api/router.js";

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the enterprise layer.
 *
 * In production, this would:
 * 1. Attach enterprise API routes to the gateway HTTP server
 * 2. Start the auto-top-up processing loop
 * 3. Register the Master Agent with the agent system
 * 4. Set up usage metering interceptors on LLM calls
 *
 * ```typescript
 * // In gateway server startup (src/gateway/server.impl.ts):
 * import { initEnterprise } from "../enterprise/index.js";
 *
 * // After HTTP server is created:
 * initEnterprise({ httpServer, cronService, config });
 * ```
 */
export function initEnterprise(deps?: {
	autoTopUpIntervalMs?: number;
}): { stop: () => void } {
	const intervalMs = deps?.autoTopUpIntervalMs ?? 60_000;

	// Start auto-top-up processing loop
	const autoTopUpInterval = setInterval(() => {
		const { processAutoTopUpQueue } = require("./billing/stripe-credits.js");
		processAutoTopUpQueue();
	}, intervalMs);

	return {
		stop: () => {
			clearInterval(autoTopUpInterval);
		},
	};
}
