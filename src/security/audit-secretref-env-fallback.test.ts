// Verifies SecretRef env-fallback security audit mapping.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSecretRefEnvFallbackFindings } from "./audit-secretref-env-fallback.js";

vi.mock("../secrets/secretref-env-fallback-diagnostics.js", () => ({
  collectSecretRefEnvFallbackDiagnostics: vi.fn(async () => [
    {
      code: "GATEWAY_AUTH_TOKEN_SECRETREF_ENV_FALLBACK",
      path: "gateway.auth.token",
      message:
        "gateway.auth.token SecretRef could not be resolved; runtime is using OPENCLAW_GATEWAY_TOKEN env fallback.",
    },
  ]),
}));

describe("security audit SecretRef env fallback findings", () => {
  it("maps shared diagnostics to a security audit finding", async () => {
    const findings = await collectSecretRefEnvFallbackFindings({
      cfg: {} satisfies OpenClawConfig,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("secrets.ref_env_fallback_used");
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.detail).toContain("gateway.auth.token");
  });
});
