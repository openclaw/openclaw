import type { OpenClawConfig } from "../../../config/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import { resolveAgentHarnessOwnerPluginIds } from "../agents/harness/runtime-plugin.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";

export function resolveRouteHarnessOwnerPluginIds(
  config: OpenClawConfig,
  route: SystemAgentConfiguredRoute,
): string[] {
  if (route.runner !== "embedded") {
    return [];
  }
  const harnessOverride = route.agentHarnessRuntimeOverride;
  // The bounded "reply OK" verification probe applies streamParams: { maxTokens } (a request
  // transport override) whenever no explicit harness is pinned. Codex declines authored
  // transport overrides and falls back to OpenClaw, so the live run never records a Codex
  // owner for that probe. Resolve the same fallback here so the staged owner snapshot matches
  // the bound execution instead of recording a harness the run never used.
  const requestTransportOverrides =
    harnessOverride && harnessOverride !== "openclaw" ? "none" : "present";
  const runtime =
    harnessOverride ??
    resolveAvailableAgentHarnessPolicy({
      config: route.sourceConfig,
      agentId: route.agentId,
      provider: route.provider,
      modelId: route.model,
      requestTransportOverrides,
    }).runtime;
  if (!runtime || runtime === "openclaw" || runtime === "auto") {
    return [];
  }
  const workspaceDir = resolveAgentWorkspaceDir(config, route.agentId, process.env);
  return resolveAgentHarnessOwnerPluginIds({
    runtime,
    provider: route.provider,
    config,
    workspaceDir,
  });
}
