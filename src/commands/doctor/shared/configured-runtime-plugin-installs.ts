import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectConfiguredAgentHarnessRuntimes,
  type ConfiguredAgentHarnessRuntimeOptions,
} from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";

type ConfiguredRuntimePluginInstallCandidate = Pick<
  PluginPackageInstall,
  "npmSpec" | "clawhubSpec" | "defaultChoice"
> & {
  pluginId: string;
  label: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
};

export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly ConfiguredRuntimePluginInstallCandidate[] =
  [
    {
      pluginId: "acpx",
      label: "ACPX Runtime",
      npmSpec: "@openclaw/acpx",
      trustedSourceLinkedOfficialInstall: true,
    },
    // Runtime-only configs do not have a provider/channel integration catalog entry.
    {
      pluginId: "codex",
      label: "Codex",
      npmSpec: "@openclaw/codex",
      trustedSourceLinkedOfficialInstall: true,
      versionBoundToOpenClaw: true,
    },
  ];

export const VERSION_BOUND_RUNTIME_PLUGIN_IDS: ReadonlySet<string> = new Set(
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.filter(
    (candidate) => candidate.versionBoundToOpenClaw,
  ).map((candidate) => candidate.pluginId),
);

export const VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE = {
  allow: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  deny: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  entries: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} as const;

/** Resolve the official install candidate for a configured runtime id. */
export function resolveConfiguredRuntimePluginInstallCandidate(
  runtimeId: string,
): ConfiguredRuntimePluginInstallCandidate | undefined {
  return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find(
    (candidate) => candidate.pluginId === runtimeId,
  );
}

export function acpxRuntimeIsConfigured(cfg: OpenClawConfig): boolean {
  const acp = asOptionalRecord(cfg.acp);
  const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  return (
    (backend === "acpx" ||
      acp?.enabled === true ||
      asOptionalRecord(acp?.dispatch)?.enabled === true) &&
    (!backend || backend === "acpx")
  );
}

/** Collect runtime ids without loading plugin metadata during startup planning. */
export function collectConfiguredRuntimeIds(
  cfg: OpenClawConfig,
  options?: ConfiguredAgentHarnessRuntimeOptions,
): string[] {
  const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, options));
  if (acpxRuntimeIsConfigured(cfg)) {
    ids.add("acpx");
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
