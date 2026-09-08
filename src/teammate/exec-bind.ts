/**
 * Teammate exec-placement helpers for sandbox explain and security audit.
 */
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTeammateInstall } from "./profile.js";

export type TeammateExecPlacement = {
  installProfile: "teammate" | null;
  sandboxMode: string;
  sandboxBackend: string;
  sandboxScope: string;
  configuredHost: string;
  effectiveHost: string;
  gatewayExec: boolean;
};

export function resolveTeammateExecPlacement(
  cfg: OpenClawConfig,
  agentId?: string,
): TeammateExecPlacement {
  const sandbox = resolveSandboxConfigForAgent(cfg, agentId);
  const sandboxAvailable = sandbox.mode !== "off";
  const exec = resolveExecDefaults({
    cfg,
    ...(agentId ? { agentId } : { scope: { kind: "defaults" as const } }),
    sandboxAvailable,
  });
  const configuredHost = cfg.tools?.exec?.host ?? "auto";
  const effectiveHost = exec.effectiveHost;
  return {
    installProfile: isTeammateInstall(cfg) ? "teammate" : null,
    sandboxMode: sandbox.mode,
    sandboxBackend: sandbox.backend,
    sandboxScope: sandbox.scope,
    configuredHost,
    effectiveHost,
    gatewayExec: effectiveHost === "gateway",
  };
}

export function teammateGatewayExecViolation(
  cfg: OpenClawConfig,
  agentId?: string,
): TeammateExecPlacement | null {
  if (!isTeammateInstall(cfg)) {
    return null;
  }
  const placement = resolveTeammateExecPlacement(cfg, agentId);
  return placement.gatewayExec ? placement : null;
}
