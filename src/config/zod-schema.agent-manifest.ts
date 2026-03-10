/**
 * Agent Marketplace manifest schema.
 *
 * Validates `agent.yaml` files used by the agent marketplace.
 * This is separate from the runtime AgentEntrySchema — manifests describe
 * marketplace metadata, tier dependencies, and routing hints, while
 * AgentEntrySchema describes runtime agent configuration.
 */
import { z } from "zod";

// ── Tier & dependency ────────────────────────────────────────────────────────

const AgentTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

// ── Model config ─────────────────────────────────────────────────────────────

const ManifestModelSchema = z
  .object({
    provider: z.string(),
    primary: z.string(),
    fallbacks: z.array(z.string()).optional(),
  })
  .strict();

// ── Tools ────────────────────────────────────────────────────────────────────

const ManifestToolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

// ── Routing hints ────────────────────────────────────────────────────────────

const RoutingHintsSchema = z
  .object({
    keywords: z.array(z.string()).optional(),
    priority: z.enum(["high", "normal", "low"]).optional(),
    preferred_for: z.array(z.string()).optional(),
  })
  .strict();

// ── Retry policy ─────────────────────────────────────────────────────────────

const RetryPolicySchema = z
  .object({
    max_retries: z.number().int().min(0).optional(),
    backoff: z.enum(["linear", "exponential", "none"]).optional(),
  })
  .strict();

// ── Execution limits ─────────────────────────────────────────────────────────

const ManifestLimitsSchema = z
  .object({
    timeout_seconds: z.number().int().min(1).optional(),
    cost_limit_usd: z.number().min(0).optional(),
    context_window_tokens: z.number().int().min(1).optional(),
    retry_policy: RetryPolicySchema.optional(),
  })
  .strict();

// ── Migration entry ──────────────────────────────────────────────────────────

const MigratorSchema = z
  .object({
    from_version: z.string(),
    to_version: z.string(),
    script: z.string(),
  })
  .strict();

// ── Author metadata ──────────────────────────────────────────────────────────

const AuthorSchema = z
  .object({
    name: z.string(),
    url: z.string().url().optional(),
  })
  .strict();

// ── Identity ─────────────────────────────────────────────────────────────────

const ManifestIdentitySchema = z
  .object({
    emoji: z.string().optional(),
    theme: z.string().optional(),
  })
  .strict();

// ── Heartbeat ───────────────────────────────────────────────────────────────

const ManifestHeartbeatSchema = z
  .object({
    schedule: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── Overrides (for extends) ──────────────────────────────────────────────────

const ManifestOverridesSchema = z
  .object({
    model: ManifestModelSchema.partial().optional(),
    tools: ManifestToolsSchema.optional(),
  })
  .strict();

// ── Main agent manifest schema ───────────────────────────────────────────────

export const AgentManifestSchema = z
  .object({
    // Required fields
    id: z
      .string()
      .regex(/^[a-z0-9-]+(\/.+)?$/, "Agent ID must be lowercase alphanumeric with hyphens"),
    name: z.string().min(1),
    tier: AgentTierSchema,
    role: z.string().min(1),
    department: z.string().min(1),
    description: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver (e.g. 1.0.0)"),

    // Dependencies
    requires: z.string().nullable().optional(),

    // Model
    model: ManifestModelSchema.optional(),

    // Tools
    tools: ManifestToolsSchema.optional(),

    // Capabilities & routing
    capabilities: z.array(z.string()).optional(),
    routing_hints: RoutingHintsSchema.optional(),

    // Identity
    identity: ManifestIdentitySchema.optional(),

    // Heartbeat
    heartbeat: ManifestHeartbeatSchema.optional(),

    // Skills
    skills: z.array(z.string()).optional(),

    // Limits
    limits: ManifestLimitsSchema.optional(),

    // Versioning & migration
    migrators: z.array(MigratorSchema).optional(),

    // Deprecation
    deprecated: z.boolean().optional(),
    sunset_date: z.string().optional(),
    migration_guide: z.string().url().optional(),
    replacement: z.string().optional(),

    // Inheritance
    extends: z.string().optional(),
    overrides: ManifestOverridesSchema.optional(),

    // Author
    author: AuthorSchema.optional(),

    // Marketplace metadata
    keywords: z.array(z.string()).optional(),
    category: z.string().optional(),

    // Bundle support
    is_bundle: z.boolean().optional(),
    bundle_agents: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Tier 3 agents must have a `requires` field
    if (data.tier === 3 && !data.requires) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requires"],
        message: "Tier 3 agents must specify a parent agent in `requires`",
      });
    }

    // Tier 1 (core) cannot have `requires`
    if (data.tier === 1 && data.requires) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requires"],
        message: "Tier 1 (core) agents cannot have dependencies",
      });
    }

    // Bundle agents must have bundle_agents list
    if (data.is_bundle && (!data.bundle_agents || data.bundle_agents.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bundle_agents"],
        message: "Bundle agents must list their contained agents in `bundle_agents`",
      });
    }

    // Cannot set overrides without extends
    if (data.overrides && !data.extends) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overrides"],
        message: "`overrides` requires `extends` to specify the base agent",
      });
    }
  });

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ── Lock file schema ─────────────────────────────────────────────────────────

const LockEntrySchema = z
  .object({
    version: z.string(),
    resolved: z.string().url().optional(),
    checksum: z.string().optional(),
    installed_at: z.string().datetime(),
    scope: z.enum(["local", "project", "user"]),
    requires: z.string().optional(),
  })
  .strict();

const LockRegistrySchema = z
  .object({
    url: z.string().url(),
    synced_at: z.string().datetime().optional(),
    commit: z.string().optional(),
  })
  .strict();

export const AgentsLockSchema = z
  .object({
    lockfile_version: z.literal(1),
    agents: z.record(z.string(), LockEntrySchema).optional(),
    registry: LockRegistrySchema.optional(),
  })
  .strict();

export type AgentsLock = z.infer<typeof AgentsLockSchema>;

// ── Registry manifest schema ─────────────────────────────────────────────────

const RegistryAgentEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    tier: AgentTierSchema,
    department: z.string(),
    path: z.string(),
  })
  .strict();

export const RegistryManifestSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string(),
    agents: z.array(RegistryAgentEntrySchema),
  })
  .strict();

export type RegistryManifest = z.infer<typeof RegistryManifestSchema>;

// ── Registry config schema (for openclaw.json) ──────────────────────────────

const RegistryConfigEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string().url(),
    auth_token_env: z.string().optional(),
    description: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const AgentMarketplaceConfigSchema = z
  .object({
    default_namespace: z.string().optional(),
    registries: z.array(RegistryConfigEntrySchema).optional(),
  })
  .strict()
  .optional();

export type AgentMarketplaceConfig = z.infer<typeof AgentMarketplaceConfigSchema>;
