import { formatCliCommand } from "../cli/command-format.js";
import type { DoctorMemoryEmbeddingRuntimePayload } from "../gateway/server-methods/doctor.js";
import type { ManifestOwnerBasePolicyBlockReason } from "../plugins/manifest-owner-policy.js";

export function formatLocalRuntimeDoctorNote(facts: DoctorMemoryEmbeddingRuntimePayload): string {
  const backend = facts.backend ?? "unknown";
  const build = facts.buildInfo ? `, ${facts.buildInfo}` : "";
  const model = facts.model?.id
    ? `\nModel: ${facts.model.id}${facts.model.path ? ` (${facts.model.path})` : ""}`
    : "";
  const capabilities = facts.capabilities
    ? `\nCapabilities: ${
        [facts.capabilities.vision ? "vision" : null, facts.capabilities.draft ? "draft" : null]
          .filter(Boolean)
          .join(", ") || "text only"
      }`
    : "";
  const endpoints = facts.endpoints
    ? `\nEndpoints: ${Object.entries(facts.endpoints)
        .map(([name, status]) => `${name}=${status}`)
        .join(" ")}`
    : "";
  const loadError = facts.loadError ? `\nLoad error: ${facts.loadError}` : "";
  const state = facts.state === "ready" ? "" : ` (${facts.state})`;
  return `llama.cpp server: ${backend}${build}${state}${model}${capabilities}${endpoints}${loadError}`;
}

export function resolveLocalProviderPolicyBlockGuidance(
  reason: ManifestOwnerBasePolicyBlockReason,
  pluginId: string,
): { message: string; fix: string } {
  switch (reason) {
    case "plugins-disabled":
      return {
        message: "Plugin loading is disabled for this config.",
        fix: `Fix: ${formatCliCommand("openclaw config set plugins.enabled true --strict-json")}, or select another memory provider.`,
      };
    case "blocked-by-denylist":
      return {
        message: `Installed plugin "${pluginId}" is blocked by plugins.deny.`,
        fix: `Fix: Remove "${pluginId}" from plugins.deny, or select another memory provider.`,
      };
    case "plugin-disabled":
      return {
        message: `Installed plugin "${pluginId}" is disabled for this config.`,
        fix: `Fix: Enable it: ${formatCliCommand(`openclaw plugins enable ${pluginId} --accept-capabilities`)}, or select another memory provider.`,
      };
    case "not-in-allowlist":
      return {
        message: `Installed plugin "${pluginId}" is omitted from plugins.allow.`,
        fix: `Fix: Include "${pluginId}" in plugins.allow, or select another memory provider.`,
      };
  }
  return reason satisfies never;
}
