// Doctor node-hosting preconditions expose config combinations that leave browser auth healthy
// while machine authentication or onboarding remains unavailable.
import os from "node:os";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../agents/agent-runtime-id.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { hasConfiguredGatewayAuthSecretInput } from "../gateway/auth-config-utils.js";
import {
  PAIRING_GATEWAY_LOOPBACK_ERROR,
  resolveConfiguredPairingPublicUrl,
  resolvePairingGatewayUrl,
} from "../pairing/setup-code.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

const CHECK_ID = "core/doctor/node-hosting-preconditions";

function usesIdentityHeadersWithoutMachineCredentials(cfg: OpenClawConfig): boolean {
  return (
    !hasConfiguredGatewayAuthSecretInput(cfg, "gateway.auth.token") &&
    !hasConfiguredGatewayAuthSecretInput(cfg, "gateway.auth.password") &&
    (cfg.gateway?.auth?.mode === "trusted-proxy" ||
      (cfg.gateway?.tailscale?.mode === "serve" &&
        cfg.gateway?.auth?.mode !== "password" &&
        cfg.gateway?.auth?.mode !== "none" &&
        cfg.gateway?.auth?.allowTailscale !== false))
  );
}

function hasConfiguredNodeHosting(cfg: OpenClawConfig): boolean {
  const nodes = cfg.gateway?.nodes;
  const execConfigs = [
    cfg.tools?.exec,
    ...Object.values(cfg.agents?.entries ?? {}).map((agent) => agent.tools?.exec),
  ];
  // Bundled plugin availability and default/deny-only node policies are not hosting intent.
  return Boolean(
    cfg.plugins?.entries?.["device-pair"]?.enabled === true ||
    resolveConfiguredPairingPublicUrl(cfg) ||
    (nodes?.browser?.mode !== "off" && nodes?.browser?.node?.trim()) ||
    nodes?.pairing?.autoApproveCidrs?.length ||
    nodes?.pairing?.sshVerify ||
    nodes?.commands?.allow?.length ||
    execConfigs.some(
      (exec) =>
        exec?.host === "node" ||
        ((exec?.host ?? cfg.tools?.exec?.host ?? "auto") === "auto" && exec?.node?.trim()),
    ),
  );
}

function lacksNodeOnboardingPlugin(cfg: OpenClawConfig): boolean {
  return !resolveEffectiveEnableState({
    id: "device-pair",
    origin: "bundled",
    config: normalizePluginsConfig(cfg.plugins),
    rootConfig: cfg,
    enabledByDefault: true,
  }).enabled;
}

function lacksDeviceCapableRuntimeRoute(cfg: OpenClawConfig): boolean {
  const registry = getActivePluginRegistry();
  return listAgentIds(cfg).every((agentId) => {
    const model = resolveDefaultModelForAgent({ cfg, agentId });
    const runtime = resolveEffectiveAgentRuntime({
      cfg,
      provider: model.provider,
      modelId: model.model,
      agentId,
    });
    if (runtime === OPENCLAW_AGENT_RUNTIME_ID) {
      return false;
    }
    const harness = registry?.agentHarnesses.find((entry) => entry.harness.id === runtime)?.harness;
    // Config-only doctor must not activate plugins or mistake unknown runtime capability for denial.
    return harness !== undefined && harness.cloudPlacement?.devicePlacement === undefined;
  });
}

/** Collects config-only warnings for node authentication, onboarding, and worker ingress. */
export async function collectNodeHostingPreconditionFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  if (cfg.gateway?.mode === "remote" || !hasConfiguredNodeHosting(cfg)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const warn = (finding: Omit<HealthFinding, "checkId" | "severity">) =>
    findings.push({
      checkId: CHECK_ID,
      severity: "warning",
      category: "fix-now",
      docsUrl: "https://docs.openclaw.ai/nodes",
      ...finding,
    });
  if (lacksNodeOnboardingPlugin(cfg)) {
    warn({
      message:
        "The device-pair plugin is not enabled; node onboarding join codes and openclaw connect are unavailable.",
      path: "plugins.entries.device-pair.enabled",
      requirement: "node-onboarding-plugin",
      fixHint:
        "Set plugins.entries.device-pair.enabled: true, check that device-pair is not denied or excluded by plugins.allow, then restart the Gateway.",
    });
  }
  if (lacksDeviceCapableRuntimeRoute(cfg)) {
    warn({
      message:
        "No configured agent/model route resolves to a runtime that supports paired-device placement.",
      path: "agents",
      requirement: "device-session-runtime",
      fixHint:
        'Select an agent/model route whose runtime supports paired-device placement, then check that its plugin is enabled and its required node commands are explicitly allowed. Runtime policy is model/provider-scoped; whole-agent runtime keys are ignored. For a multi-agent roster, set agents.ownership: "explicit".',
    });
  }
  if (usesIdentityHeadersWithoutMachineCredentials(cfg)) {
    warn({
      message:
        "Gateway identity-header auth has no configured token/password path for machine clients; new node hosts cannot authenticate or become worker hosts.",
      path: "gateway.auth",
      requirement: "machine-client-auth",
      fixHint:
        "Switch gateway.auth.mode to token and configure gateway.auth.token as a SecretRef so machine clients can authenticate as devices. Keep trusted-proxy only if machine clients use a clean loopback/direct gateway.auth.password path. For Access-fronted gateways, configure the node gateway.cloudflareAccess.clientId / clientSecret SecretInputs or set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET before openclaw connect.",
    });
  }
  const bind = cfg.gateway?.bind ?? "loopback";
  // This config-only check reports missing ingress, not live Tailscale availability.
  if (
    (bind === "loopback" || bind === "auto") &&
    (
      await resolvePairingGatewayUrl(cfg, {
        env: process.env,
        publicUrl: resolveConfiguredPairingPublicUrl(cfg),
        networkInterfaces: os.networkInterfaces,
      })
    ).error === PAIRING_GATEWAY_LOOPBACK_ERROR
  ) {
    warn({
      message: PAIRING_GATEWAY_LOOPBACK_ERROR,
      path: "gateway.bind",
      requirement: "node-onboarding-url",
      fixHint:
        "If an edge proxy fronts node onboarding, allow /j/* and /__openclaw__/worker without edge identity auth, and preserve WebSocket upgrade on /__openclaw__/worker. Both routes enforce their own credentials.",
    });
  }
  return findings;
}
