import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getResolvedConfigEnvSecretRef,
  hasUnresolvedConfigPath,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "./audit.types.js";

export function collectSecretsInConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const password = normalizeOptionalString(cfg.gateway?.auth?.password) ?? "";
  if (
    password &&
    !hasUnresolvedConfigPath(cfg, "gateway.auth.password") &&
    !getResolvedConfigEnvSecretRef(cfg, "gateway.auth.password")
  ) {
    findings.push({
      checkId: "config.secrets.gateway_password_in_config",
      severity: "warn",
      title: "Gateway password is stored in config",
      detail:
        "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer OPENCLAW_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk.",
    });
  }

  const hooksToken = normalizeOptionalString(cfg.hooks?.token) ?? "";
  if (
    cfg.hooks?.enabled === true &&
    hooksToken &&
    !hasUnresolvedConfigPath(cfg, "hooks.token") &&
    !getResolvedConfigEnvSecretRef(cfg, "hooks.token")
  ) {
    findings.push({
      checkId: "config.secrets.hooks_token_in_config",
      severity: "info",
      title: "Hooks token is stored in config",
      detail:
        "hooks.token is set in the config file; keep config perms tight and treat it like an API secret.",
    });
  }

  return findings;
}
