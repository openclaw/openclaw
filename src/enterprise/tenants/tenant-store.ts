/**
 * Tenant Store — SQLite-backed persistence for orgs, teams, members, API keys.
 *
 * In production this would use Postgres/Turso, but SQLite keeps the system
 * self-contained and deployable anywhere with zero external deps.
 */

import crypto from "node:crypto";
import type {
  ApiKey,
  ApiKeyId,
  Organization,
  OrgId,
  OrgSettings,
  Plan,
  Role,
  Team,
  TeamId,
  TeamMember,
  TenantContext,
  UserId,
} from "./types.js";
import { ROLE_PERMISSIONS, PLAN_QUOTAS } from "./types.js";

// ── ID Generation ────────────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `oc_${crypto.randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 11) };
}

// ── In-Memory Store (swap for SQLite/Postgres in prod) ───────────────────────

interface StoreState {
  orgs: Map<OrgId, Organization>;
  teams: Map<TeamId, Team>;
  members: TeamMember[];
  apiKeys: Map<ApiKeyId, ApiKey>;
}

const store: StoreState = {
  orgs: new Map(),
  teams: new Map(),
  members: [],
  apiKeys: new Map(),
};

// ── Organization CRUD ────────────────────────────────────────────────────────

export function createOrg(params: {
  name: string;
  slug: string;
  plan?: Plan;
  ownerId: UserId;
}): Organization {
  const id = generateId("org") as OrgId;
  const now = new Date();
  const org: Organization = {
    id,
    name: params.name,
    slug: params.slug,
    plan: params.plan ?? "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: now,
    updatedAt: now,
    settings: {
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      allowedProviders: [],
      globalSystemPrompt: "",
      webhookUrl: null,
      webhookSecret: null,
    },
  };
  store.orgs.set(id, org);

  // Auto-create default team with owner
  const teamId = generateId("team") as TeamId;
  store.teams.set(teamId, { id: teamId, orgId: id, name: "Default", createdAt: now });
  store.members.push({ teamId, userId: params.ownerId, role: "owner", joinedAt: now });

  return org;
}

export function getOrg(id: OrgId): Organization | undefined {
  return store.orgs.get(id);
}

export function updateOrgPlan(id: OrgId, plan: Plan): void {
  const org = store.orgs.get(id);
  if (!org) {
    throw new Error(`Org ${id} not found`);
  }
  org.plan = plan;
  org.updatedAt = new Date();
}

export function updateOrgSettings(id: OrgId, settings: Partial<OrgSettings>): void {
  const org = store.orgs.get(id);
  if (!org) {
    throw new Error(`Org ${id} not found`);
  }
  org.settings = { ...org.settings, ...settings };
  org.updatedAt = new Date();
}

export function listOrgs(): Organization[] {
  return [...store.orgs.values()];
}

// ── Team CRUD ────────────────────────────────────────────────────────────────

export function createTeam(orgId: OrgId, name: string): Team {
  const id = generateId("team") as TeamId;
  const team: Team = { id, orgId, name, createdAt: new Date() };
  store.teams.set(id, team);
  return team;
}

export function listTeams(orgId: OrgId): Team[] {
  return [...store.teams.values()].filter((t) => t.orgId === orgId);
}

export function addTeamMember(teamId: TeamId, userId: UserId, role: Role): void {
  store.members.push({ teamId, userId, role, joinedAt: new Date() });
}

export function getTeamMembers(teamId: TeamId): TeamMember[] {
  return store.members.filter((m) => m.teamId === teamId);
}

// ── API Key Management ───────────────────────────────────────────────────────

export function createApiKey(params: {
  orgId: OrgId;
  name: string;
  permissions?: string[];
  rateLimit?: number;
  expiresAt?: Date;
}): { apiKey: ApiKey; rawKey: string } {
  const { raw, hash, prefix } = generateApiKey();
  const id = generateId("key") as ApiKeyId;
  const apiKey: ApiKey = {
    id,
    orgId: params.orgId,
    name: params.name,
    keyHash: hash,
    keyPrefix: prefix,
    permissions: (params.permissions ?? []) as ApiKey["permissions"],
    rateLimit: params.rateLimit ?? 60,
    lastUsedAt: null,
    expiresAt: params.expiresAt ?? null,
    createdAt: new Date(),
    revokedAt: null,
  };
  store.apiKeys.set(id, apiKey);
  return { apiKey, rawKey: raw };
}

export function resolveApiKey(rawKey: string): ApiKey | undefined {
  const hash = hashApiKey(rawKey);
  for (const key of store.apiKeys.values()) {
    if (key.keyHash === hash && !key.revokedAt) {
      key.lastUsedAt = new Date();
      return key;
    }
  }
  return undefined;
}

export function revokeApiKey(id: ApiKeyId): void {
  const key = store.apiKeys.get(id);
  if (key) {
    key.revokedAt = new Date();
  }
}

// ── Tenant Context Resolution ────────────────────────────────────────────────

export function resolveTenantContext(orgId: OrgId, userId: UserId): TenantContext | undefined {
  const org = store.orgs.get(orgId);
  if (!org) {
    return undefined;
  }

  const membership = store.members.find((m) => m.userId === userId);
  if (!membership) {
    return undefined;
  }

  return {
    orgId,
    userId,
    teamId: membership.teamId,
    role: membership.role,
    permissions: [...ROLE_PERMISSIONS[membership.role]],
    plan: org.plan,
    quotas: PLAN_QUOTAS[org.plan],
  };
}

/** Check if a tenant context has a specific permission */
export function hasPermission(ctx: TenantContext, permission: string): boolean {
  return ctx.permissions.includes(permission as TenantContext["permissions"][number]);
}
