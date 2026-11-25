import { resolveOpenClawReleaseCohortVersion } from "./npm-registry-spec.js";
import type { UpdateRunResult } from "./update-run-result.js";

type PluginUpdate = NonNullable<NonNullable<UpdateRunResult["postUpdate"]>["plugins"]>;

/** Match a complete shipped Doctor finding; do not absorb multiline unrelated advice. */
export function readPluginVersionDriftWarning(message: string | undefined) {
  const [, pluginId, previousVersion, gatewayVersion, confirmedTarget] =
    /^(?:core\/doctor\/workspace-status: )?Plugin (\S+) is (\S+), but a Gateway restart will load OpenClaw (\S+)\.(?: The confirmed plugin target is (\S+)\.)?(?: The running Gateway is \S+\.)?(?: Repair target resolution failed: [^\r\n]+)?$/u.exec(
      message ?? "",
    ) ?? [];
  return pluginId && previousVersion && gatewayVersion
    ? { pluginId, previousVersion, gatewayVersion, confirmedTarget }
    : undefined;
}

/** A version warning is stale only when the final outcome confirms its target version. */
export function readRetiredPluginVersionDriftWarnings(
  messages: readonly (string | undefined)[],
  plugins: PluginUpdate | undefined,
): Set<string> {
  const retired = new Set<string>();
  if (
    (plugins?.status !== "ok" && plugins?.status !== "warning") ||
    plugins.warnings?.some(
      ({ reason }) => reason === "plugin-config-conflict" || reason === "plugin-convergence",
    )
  ) {
    return retired;
  }
  const finalOutcomes = new Map(
    (plugins.npm?.outcomes ?? []).map((outcome) => [outcome.pluginId, outcome]),
  );
  for (const message of messages) {
    const drift = readPluginVersionDriftWarning(message);
    if (!message || !drift) {
      continue;
    }
    const { pluginId, gatewayVersion, previousVersion, confirmedTarget } = drift;
    if (
      plugins.warnings?.some(
        (warning) =>
          warning.pluginId === pluginId &&
          (warning.reason === "plugin-version-mismatch" ||
            warning.reason === "plugin-target-unavailable"),
      )
    ) {
      continue;
    }
    const outcome = finalOutcomes.get(pluginId);
    const version =
      outcome?.status === "updated"
        ? outcome.nextVersion
        : outcome?.status === "unchanged"
          ? outcome.currentVersion
          : undefined;
    if (
      version &&
      version !== previousVersion &&
      (confirmedTarget
        ? version === confirmedTarget
        : resolveOpenClawReleaseCohortVersion(version) ===
          resolveOpenClawReleaseCohortVersion(gatewayVersion))
    ) {
      retired.add(message);
    }
  }
  return retired;
}
