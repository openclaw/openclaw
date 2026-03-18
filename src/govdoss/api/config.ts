import { z } from "zod";

const GovdossApiConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GOVDOSS_API_PORT: z.coerce.number().int().positive().default(8787),
  GOVDOSS_API_HOST: z.string().min(1).default("0.0.0.0"),
  GOVDOSS_API_KEYS_REQUIRED: z.coerce.boolean().default(true),
  GOVDOSS_REDIS_URL: z.string().min(1).optional(),
  GOVDOSS_DATABASE_URL: z.string().min(1).optional(),
  GOVDOSS_AUDIT_SINK: z.enum(["memory", "jsonl", "postgres"]).default("memory"),
  GOVDOSS_APPROVAL_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  GOVDOSS_USAGE_BACKEND: z.enum(["memory", "postgres"]).default("memory"),
  GOVDOSS_REQUIRE_TLS_PROXY: z.coerce.boolean().default(false),
  GOVDOSS_TRUST_PROXY: z.coerce.boolean().default(false),
});

export type GovdossApiConfig = z.infer<typeof GovdossApiConfigSchema>;

export function loadGovdossApiConfig(env: NodeJS.ProcessEnv = process.env): GovdossApiConfig {
  return GovdossApiConfigSchema.parse(env);
}

export function assertGovdossProductionReadiness(config: GovdossApiConfig): string[] {
  const issues: string[] = [];
  if (config.NODE_ENV === "production") {
    if (config.GOVDOSS_API_KEYS_REQUIRED !== true) {
      issues.push("api keys must be required in production");
    }
    if (config.GOVDOSS_APPROVAL_BACKEND === "memory") {
      issues.push("approval backend should not remain memory in production");
    }
    if (config.GOVDOSS_USAGE_BACKEND === "memory") {
      issues.push("usage backend should not remain memory in production");
    }
    if (config.GOVDOSS_AUDIT_SINK === "memory") {
      issues.push("audit sink should not remain memory in production");
    }
  }
  return issues;
}
