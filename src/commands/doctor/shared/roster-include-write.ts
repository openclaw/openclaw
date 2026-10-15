import { setConfigValueAtPath, unsetConfigValueAtPath } from "../../../config/config-paths.js";
import { collectChangedConfigPaths } from "../../../config/include-write-boundary.js";
import type { ConfigWriteOptions } from "../../../config/io.js";
import { projectWebhookMigrationIncludeWrite } from "../../../config/io.meta.js";
import { resolveConfigIncludeWriteBoundary } from "../../../config/mutate.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InstalledPluginIdRecovery } from "./installed-plugin-id-recovery.js";

/** Plan one guarded owner write and retain the exact paths still awaiting publication. */
export function prepareDoctorConfigWriteStage(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  persistCanonicalAgentRoster?: boolean;
  installedPluginIdRecovery?: InstalledPluginIdRecovery;
  explicitSetPaths?: ConfigWriteOptions["explicitSetPaths"];
}):
  | { config: OpenClawConfig; remainingPaths: string[][]; persistCanonicalAgentRoster: boolean }
  | undefined {
  const steeringPath = ["messages", "queue", "allowCollaborativeSteering"];
  if (
    params.snapshot.sourceConfig.messages?.queue?.allowCollaborativeSteering === undefined &&
    params.nextConfig.messages?.queue?.allowCollaborativeSteering === true
  ) {
    // A new root default must not block a repair owned by an included file.
    const withoutDefault = cloneConfigWithResolutionFacts(params.nextConfig);
    unsetConfigValueAtPath(withoutDefault, steeringPath, params.snapshot.sourceConfig);
    const priorStage = prepareDoctorConfigWriteStage({ ...params, nextConfig: withoutDefault });
    if (priorStage) {
      return { ...priorStage, remainingPaths: [...priorStage.remainingPaths, steeringPath] };
    }
    if (resolveConfigIncludeWriteBoundary({ ...params, nextConfig: withoutDefault })) {
      return {
        config: withoutDefault,
        remainingPaths: [steeringPath],
        persistCanonicalAgentRoster: params.persistCanonicalAgentRoster === true,
      };
    }
    const defaultOnly = cloneConfigWithResolutionFacts(params.snapshot.sourceConfig);
    setConfigValueAtPath(defaultOnly, steeringPath, true);
    const remaining = collectChangedConfigPaths(defaultOnly, params.nextConfig);
    if (
      remaining.paths.length > 0 &&
      resolveConfigIncludeWriteBoundary({
        snapshot: params.snapshot,
        nextConfig: defaultOnly,
      })
    ) {
      return {
        config: defaultOnly,
        remainingPaths: remaining.paths.map((field) => [...field]),
        persistCanonicalAgentRoster: false,
      };
    }
  }
  const webhook = projectWebhookMigrationIncludeWrite(
    params.snapshot.sourceConfig,
    params.nextConfig,
  );
  const remainingPaths = webhook?.paths ?? [];
  if (webhook) {
    const markerPath = ["meta", "migrations", "webhookListeners"];
    const previous = params.snapshot.sourceConfig.meta?.migrations?.webhookListeners;
    if (previous === undefined) {
      unsetConfigValueAtPath(webhook.config, markerPath, params.snapshot.sourceConfig);
    } else {
      setConfigValueAtPath(webhook.config, markerPath, previous);
    }
    remainingPaths.push(markerPath);
    if (resolveConfigIncludeWriteBoundary({ ...params, nextConfig: webhook.config })) {
      return { config: webhook.config, remainingPaths, persistCanonicalAgentRoster: false };
    }
  }
  if (!params.persistCanonicalAgentRoster || !params.installedPluginIdRecovery?.size) {
    return undefined;
  }
  const includeCandidate = cloneConfigWithResolutionFacts(webhook?.config ?? params.nextConfig);
  includeCandidate.agents = params.snapshot.sourceConfig.agents;
  const boundary = resolveConfigIncludeWriteBoundary({
    snapshot: params.snapshot,
    nextConfig: includeCandidate,
    explicitSetPaths: params.explicitSetPaths?.filter(([key]) => key !== "agents"),
  });
  if (!boundary || boundary.boundaryPath[0] !== "plugins") {
    return undefined;
  }
  const rosterCandidate = cloneConfigWithResolutionFacts(params.snapshot.sourceConfig);
  rosterCandidate.agents = params.nextConfig.agents;
  return {
    config: rosterCandidate,
    remainingPaths: [["plugins"], ...remainingPaths],
    persistCanonicalAgentRoster: true,
  };
}

/** Preview the same physical-owner sequence that the guarded Doctor writer uses. */
export function canWriteDoctorInclude(
  snapshot: ConfigFileSnapshot,
  nextConfig: OpenClawConfig,
  options: Pick<ConfigWriteOptions, "persistCanonicalAgentRoster" | "explicitSetPaths">,
  installedPluginIdRecovery: InstalledPluginIdRecovery | undefined,
): boolean {
  return Boolean(
    resolveConfigIncludeWriteBoundary({ snapshot, nextConfig, ...options }) ||
    prepareDoctorConfigWriteStage({
      snapshot,
      nextConfig,
      ...options,
      installedPluginIdRecovery,
    }),
  );
}
