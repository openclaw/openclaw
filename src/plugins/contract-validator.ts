import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";

export type PluginContractValidationFinding = {
  level: "error" | "warn";
  code:
    | "manifest-diagnostic"
    | "missing-tool-contract"
    | "tool-metadata-without-contract"
    | "tool-contract-without-metadata";
  pluginId?: string;
  source?: string;
  message: string;
};

export type PluginContractValidationResult = {
  ok: boolean;
  strict: boolean;
  pluginCount: number;
  findingCount: number;
  findings: PluginContractValidationFinding[];
};

function findingFromDiagnostic(diag: PluginDiagnostic): PluginContractValidationFinding {
  return {
    level: diag.level === "error" ? "error" : "warn",
    code: "manifest-diagnostic",
    ...(diag.pluginId ? { pluginId: diag.pluginId } : {}),
    ...(diag.source ? { source: diag.source } : {}),
    message: diag.message,
  };
}

function listToolMetadataNames(plugin: PluginManifestRecord): string[] {
  return Object.keys(plugin.toolMetadata ?? {})
    .filter((name) => name.trim())
    .toSorted();
}

function listContractToolNames(plugin: PluginManifestRecord): string[] {
  return [
    ...new Set((plugin.contracts?.tools ?? []).map((name) => name.trim()).filter(Boolean)),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function validatePluginContracts(params: {
  config?: OpenClawConfig;
  strict?: boolean;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
}): PluginContractValidationResult {
  const strict = params.strict === true;
  const registry = loadPluginManifestRegistry({
    config: params.config,
    env: params.env,
    candidates: params.candidates,
  });
  const findings: PluginContractValidationFinding[] =
    registry.diagnostics.map(findingFromDiagnostic);

  for (const plugin of registry.plugins) {
    const metadataTools = listToolMetadataNames(plugin);
    const contractTools = listContractToolNames(plugin);
    if (metadataTools.length > 0 && contractTools.length === 0) {
      findings.push({
        level: "error",
        code: "missing-tool-contract",
        pluginId: plugin.id,
        source: plugin.manifestPath,
        message:
          "plugin declares toolMetadata but is missing contracts.tools; tool registrations are rejected in strict mode",
      });
      continue;
    }

    const contractSet = new Set(contractTools);
    for (const toolName of metadataTools) {
      if (!contractSet.has(toolName)) {
        findings.push({
          level: "error",
          code: "tool-metadata-without-contract",
          pluginId: plugin.id,
          source: plugin.manifestPath,
          message: `toolMetadata.${toolName} is not declared in contracts.tools`,
        });
      }
    }

    if (!strict) {
      continue;
    }
    const metadataSet = new Set(metadataTools);
    for (const toolName of contractTools) {
      if (!metadataSet.has(toolName)) {
        findings.push({
          level: "warn",
          code: "tool-contract-without-metadata",
          pluginId: plugin.id,
          source: plugin.manifestPath,
          message: `contracts.tools declares ${toolName} without matching toolMetadata`,
        });
      }
    }
  }

  const hasErrors = findings.some((finding) => finding.level === "error");
  return {
    ok: !hasErrors,
    strict,
    pluginCount: registry.plugins.length,
    findingCount: findings.length,
    findings,
  };
}
