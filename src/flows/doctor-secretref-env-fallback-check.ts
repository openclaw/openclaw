import type { HealthCheck } from "./health-checks.js";

const SECRETREF_ENV_FALLBACK_CHECK_ID = "core/doctor/secretref-env-fallback";

export const secretRefEnvFallbackCheck: HealthCheck = {
  id: SECRETREF_ENV_FALLBACK_CHECK_ID,
  kind: "core",
  description: "Configured SecretRefs are not silently falling back to provider env credentials.",
  source: "doctor",
  async detect(ctx) {
    const { collectSecretRefEnvFallbackDiagnostics } =
      await import("../secrets/secretref-env-fallback-diagnostics.js");
    const diagnostics = await collectSecretRefEnvFallbackDiagnostics({
      cfg: ctx.cfg,
      env: process.env,
      allowExec: ctx.allowExecSecretRefs === true,
    });
    return diagnostics.map((entry) => ({
      checkId: SECRETREF_ENV_FALLBACK_CHECK_ID,
      severity: "warning",
      message: entry.message,
      path: entry.path,
      fixHint:
        "Resolve the configured SecretRef source or remove stale env fallback credentials so runtime uses the intended secret boundary.",
    }));
  },
};
