/**
 * Enterprise Multi-Tenant System
 *
 * Org → Team → User hierarchy with RBAC, API key scoping, and quota enforcement.
 * Every agent execution, LLM call, and tool invocation is scoped to a tenant.
 */

// ── Identifiers ──────────────────────────────────────────────────────────────

export type OrgId = string & { readonly __brand: "OrgId" };
export type TeamId = string & { readonly __brand: "TeamId" };
export type UserId = string & { readonly __brand: "UserId" };
export type ApiKeyId = string & { readonly __brand: "ApiKeyId" };

// ── Roles & Permissions ──────────────────────────────────────────────────────

export const ROLES = ["owner", "admin", "member", "billing", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
	"org:manage",
	"org:billing",
	"org:view",
	"team:manage",
	"team:view",
	"agents:create",
	"agents:execute",
	"agents:view",
	"agents:delete",
	"channels:manage",
	"channels:view",
	"api_keys:manage",
	"api_keys:view",
	"usage:view",
	"marketplace:publish",
	"marketplace:install",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
	owner: PERMISSIONS,
	admin: PERMISSIONS.filter((p) => p !== "org:billing"),
	billing: ["org:billing", "org:view", "usage:view"],
	member: [
		"org:view",
		"team:view",
		"agents:create",
		"agents:execute",
		"agents:view",
		"channels:view",
		"api_keys:view",
		"usage:view",
		"marketplace:install",
	],
	viewer: ["org:view", "team:view", "agents:view", "channels:view", "usage:view"],
};

// ── Plan & Quotas ────────────────────────────────────────────────────────────

export const PLANS = ["free", "starter", "growth", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanQuotas {
	maxAgents: number;
	maxChannels: number;
	maxTeamMembers: number;
	maxApiKeys: number;
	/** Monthly token budget (input + output combined) */
	monthlyTokenBudget: number;
	/** Monthly message limit across all channels */
	monthlyMessageLimit: number;
	/** Monthly tool execution limit */
	monthlyToolExecutionLimit: number;
	/** Whether cron/scheduled agents are allowed */
	cronAgentsEnabled: boolean;
	/** Whether marketplace publishing is allowed */
	marketplacePublishEnabled: boolean;
	/** Priority support */
	prioritySupport: boolean;
}

export const PLAN_QUOTAS: Record<Plan, PlanQuotas> = {
	free: {
		maxAgents: 2,
		maxChannels: 2,
		maxTeamMembers: 1,
		maxApiKeys: 1,
		monthlyTokenBudget: 500_000,
		monthlyMessageLimit: 500,
		monthlyToolExecutionLimit: 200,
		cronAgentsEnabled: false,
		marketplacePublishEnabled: false,
		prioritySupport: false,
	},
	starter: {
		maxAgents: 10,
		maxChannels: 5,
		maxTeamMembers: 5,
		maxApiKeys: 5,
		monthlyTokenBudget: 5_000_000,
		monthlyMessageLimit: 5_000,
		monthlyToolExecutionLimit: 2_000,
		cronAgentsEnabled: true,
		marketplacePublishEnabled: false,
		prioritySupport: false,
	},
	growth: {
		maxAgents: 50,
		maxChannels: 15,
		maxTeamMembers: 25,
		maxApiKeys: 20,
		monthlyTokenBudget: 50_000_000,
		monthlyMessageLimit: 50_000,
		monthlyToolExecutionLimit: 20_000,
		cronAgentsEnabled: true,
		marketplacePublishEnabled: true,
		prioritySupport: true,
	},
	enterprise: {
		maxAgents: Infinity,
		maxChannels: Infinity,
		maxTeamMembers: Infinity,
		maxApiKeys: Infinity,
		monthlyTokenBudget: Infinity,
		monthlyMessageLimit: Infinity,
		monthlyToolExecutionLimit: Infinity,
		cronAgentsEnabled: true,
		marketplacePublishEnabled: true,
		prioritySupport: true,
	},
};

// ── Core Entities ────────────────────────────────────────────────────────────

export interface Organization {
	id: OrgId;
	name: string;
	slug: string;
	plan: Plan;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
	createdAt: Date;
	updatedAt: Date;
	settings: OrgSettings;
}

export interface OrgSettings {
	/** Default model provider for new agents */
	defaultProvider: string;
	/** Default model ID */
	defaultModel: string;
	/** Allowed model providers (empty = all) */
	allowedProviders: string[];
	/** Custom system prompt prepended to all agents */
	globalSystemPrompt: string;
	/** Webhook URL for event notifications */
	webhookUrl: string | null;
	/** Webhook secret for HMAC verification */
	webhookSecret: string | null;
}

export interface Team {
	id: TeamId;
	orgId: OrgId;
	name: string;
	createdAt: Date;
}

export interface TeamMember {
	teamId: TeamId;
	userId: UserId;
	role: Role;
	joinedAt: Date;
}

export interface ApiKey {
	id: ApiKeyId;
	orgId: OrgId;
	name: string;
	/** Hashed key — never store plaintext */
	keyHash: string;
	/** First 8 chars for identification */
	keyPrefix: string;
	permissions: Permission[];
	/** Rate limit: requests per minute */
	rateLimit: number;
	lastUsedAt: Date | null;
	expiresAt: Date | null;
	createdAt: Date;
	revokedAt: Date | null;
}

// ── Tenant Context ───────────────────────────────────────────────────────────

/** Injected into every request/agent execution for scoping */
export interface TenantContext {
	orgId: OrgId;
	userId: UserId;
	teamId: TeamId | null;
	role: Role;
	permissions: Permission[];
	plan: Plan;
	quotas: PlanQuotas;
}
