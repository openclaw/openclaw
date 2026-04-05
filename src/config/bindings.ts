import type { MullusiConfig } from "./config.js";
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";

export type ConfiguredBindingRule = AgentBinding;

function normalizeBindingType(binding: AgentBinding): "route" | "acp" {
  return binding.type === "acp" ? "acp" : "route";
}

export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  return normalizeBindingType(binding) === "route";
}

export function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding {
  return normalizeBindingType(binding) === "acp";
}

export function listConfiguredBindings(cfg: MullusiConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

export function listRouteBindings(cfg: MullusiConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}

export function listAcpBindings(cfg: MullusiConfig): AgentAcpBinding[] {
  return listConfiguredBindings(cfg).filter(isAcpBinding);
}
