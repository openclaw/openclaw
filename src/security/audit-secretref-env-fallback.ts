/** Maps shared SecretRef env-fallback diagnostics into security audit findings. */
import type { OpenClawConfig } from "../config/config.js";
import { collectSecretRefEnvFallbackDiagnostics } from "../secrets/secretref-env-fallback-diagnostics.js";
import type { SecurityAuditFinding } from "./audit.types.js";

/** Collect audit findings when configured SecretRefs fall back to provider env vars. */
export async function collectSecretRefEnvFallbackFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Defaults false so routine security audit never launches exec SecretRef commands. */
  allowExec?: boolean;
}): Promise<SecurityAuditFinding[]> {
  const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
    cfg: params.cfg,
    env: params.env,
    allowExec: params.allowExec === true,
  });
  if (diagnostics.length === 0) {
    return [];
  }

  return [
    {
      checkId: "secrets.ref_env_fallback_used",
      severity: "warn",
      title: "Configured SecretRef fell back to environment credentials",
      detail:
        "Runtime secret resolution used provider env fallback after a configured SecretRef failed:\n" +
        diagnostics.map((entry) => `- ${entry.path}: ${entry.message}`).join("\n"),
      remediation:
        "Fix the configured SecretRef source or remove stale env fallback credentials so runtime uses the intended secret boundary.",
    },
  ];
}
