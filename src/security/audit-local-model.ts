/**
 * Security audit checks for local-model-only (corporate LAN) deployments.
 *
 * Validates that the configuration correctly enforces local-only model
 * access and reports any potential security gaps.
 */

import { isLocalBaseUrl } from "../agents/local-model-provider.js";
import type { OpenClawConfig } from "../config/config.js";
import type { LocalModelSecurityConfig } from "../config/types.local-model-security.js";
import type { SecurityAuditFinding } from "./audit-extra.sync.js";
import { isCloudProviderHost, resolveSecurityMode } from "./network-egress-guard.js";

/**
 * Collect security findings specific to local-model-security configuration.
 */
export function collectLocalModelSecurityFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const securityConfig = cfg.localModelSecurity;
  const mode = resolveSecurityMode(securityConfig);

  if (mode === "off") {
    return findings;
  }

  // Check: mode is "audit" (not enforced) — warn that violations aren't blocked.
  if (mode === "audit") {
    findings.push({
      checkId: "local-model-audit-only",
      severity: "warn",
      title: "Local model security in audit-only mode",
      detail:
        'localModelSecurity.mode is "audit" — violations are logged but not blocked. ' +
        "External API calls can still reach cloud providers.",
      remediation:
        'Set localModelSecurity.mode to "enforced" to block all external model API calls.',
    });
  }

  // Check: no local providers configured.
  if (!securityConfig?.localProviders || securityConfig.localProviders.length === 0) {
    findings.push({
      checkId: "local-model-no-providers",
      severity: "warn",
      title: "No local model providers configured",
      detail:
        "localModelSecurity is enabled but no localProviders are configured. " +
        "Model inference may not work without at least one local provider (Ollama, vLLM, etc.).",
      remediation:
        "Add at least one entry to localModelSecurity.localProviders with your Ollama or vLLM server URL.",
    });
  }

  // Check: local providers point to non-local addresses.
  if (securityConfig?.localProviders) {
    for (const provider of securityConfig.localProviders) {
      if (!isLocalBaseUrl(provider.baseUrl)) {
        findings.push({
          checkId: "local-model-nonlocal-provider",
          severity: "critical",
          title: `Local provider "${provider.name ?? provider.type}" uses non-local URL`,
          detail:
            `Provider baseUrl "${provider.baseUrl}" does not resolve to a local/private network address. ` +
            "This may leak model requests to an external server.",
          remediation:
            "Use a local IP address (192.168.x.x, 10.x.x.x, 172.16-31.x.x) or hostname (.local, .lan).",
        });
      }
    }
  }

  // Check: cloud providers not blocked.
  if (mode === "enforced" && securityConfig?.blockCloudProviders === false) {
    findings.push({
      checkId: "local-model-cloud-not-blocked",
      severity: "critical",
      title: "Cloud providers not blocked in enforced mode",
      detail:
        "localModelSecurity.mode is enforced but blockCloudProviders is explicitly set to false. " +
        "This allows requests to cloud AI APIs (Anthropic, OpenAI, Google, etc.).",
      remediation: "Remove blockCloudProviders: false or set it to true.",
    });
  }

  // Check: web access not blocked.
  if (mode === "enforced" && securityConfig?.blockWebAccess === false) {
    findings.push({
      checkId: "local-model-web-not-blocked",
      severity: "warn",
      title: "Web access not blocked in enforced mode",
      detail:
        "Web search and fetch tools can still make external HTTP requests. " +
        "This may allow data exfiltration via web tools.",
      remediation: "Set localModelSecurity.blockWebAccess to true.",
    });
  }

  // Check: telemetry not blocked.
  if (mode === "enforced" && securityConfig?.blockTelemetry === false) {
    findings.push({
      checkId: "local-model-telemetry-not-blocked",
      severity: "info",
      title: "Telemetry and update checks not blocked",
      detail:
        "Update checks and telemetry may still reach external servers. " +
        "This may be acceptable depending on your network policy.",
      remediation: "Set localModelSecurity.blockTelemetry to true for air-gapped deployments.",
    });
  }

  // Check: TLS not required for non-loopback local providers.
  if (securityConfig?.localProviders) {
    for (const provider of securityConfig.localProviders) {
      const requireTls = provider.requireTls ?? securityConfig?.requireTls ?? false;
      if (!requireTls) {
        continue;
      }
      try {
        const parsed = new URL(provider.baseUrl);
        const hostname = parsed.hostname.toLowerCase();
        const isLoopback =
          hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
        if (!isLoopback && parsed.protocol !== "https:") {
          findings.push({
            checkId: "local-model-no-tls",
            severity: "warn",
            title: `Provider "${provider.name ?? provider.type}" using plain HTTP on LAN`,
            detail:
              `Provider at ${provider.baseUrl} uses HTTP instead of HTTPS. ` +
              "LAN traffic may be intercepted by other devices on the network.",
            remediation:
              "Configure your local model server with TLS, or accept the risk for trusted LANs.",
          });
        }
      } catch {
        // Invalid URL — already caught by schema validation.
      }
    }
  }

  // Check: network egress policy not configured.
  if (!securityConfig?.networkEgress) {
    findings.push({
      checkId: "local-model-no-egress-policy",
      severity: "info",
      title: "No network egress policy configured",
      detail:
        "localModelSecurity is enabled but networkEgress is not configured. " +
        "Default behavior blocks external requests when mode is enforced.",
      remediation:
        "Add a networkEgress configuration with explicit allowedHosts for your local servers.",
    });
  }

  // Check: existing cloud provider configs that would be blocked.
  checkExistingCloudProviders(cfg, securityConfig, findings);

  return findings;
}

function checkExistingCloudProviders(
  cfg: OpenClawConfig,
  securityConfig: LocalModelSecurityConfig | undefined,
  findings: SecurityAuditFinding[],
): void {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  const mode = resolveSecurityMode(securityConfig);
  const blockCloud = securityConfig?.blockCloudProviders ?? mode === "enforced";
  if (!blockCloud) {
    return;
  }

  const blockedProviders: string[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    try {
      const parsed = new URL(provider.baseUrl);
      if (isCloudProviderHost(parsed.hostname)) {
        blockedProviders.push(key);
      }
    } catch {
      // Skip invalid URLs.
    }
  }

  if (blockedProviders.length > 0) {
    findings.push({
      checkId: "local-model-existing-cloud-providers",
      severity: "info",
      title: `${blockedProviders.length} cloud provider(s) will be blocked`,
      detail:
        `The following configured model providers will be blocked in local-only mode: ${blockedProviders.join(", ")}. ` +
        "Remove them from models.providers to avoid confusion.",
      remediation:
        "Remove cloud provider entries from models.providers, or switch to local model providers.",
    });
  }
}
