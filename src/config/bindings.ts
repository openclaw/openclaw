// Normalizes agent binding config for channels, routes, and ACP sessions.
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Narrows a configured binding to the channel route form. */
export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  // Missing `type` is the legacy/default route binding shape.
  return binding.type !== "acp";
}

function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding {
  return binding.type === "acp";
}

/** Returns the configured binding list, treating missing/non-array config as empty. */
export function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

/** Lists channel route bindings, including legacy bindings without an explicit type. */
export function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}

/** Lists ACP conversation bindings only. */
export function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[] {
  return listConfiguredBindings(cfg).filter(isAcpBinding);
}
