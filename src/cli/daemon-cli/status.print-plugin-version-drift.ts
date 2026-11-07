import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import {
  formatPluginVersionDriftRetainedNpmSelector,
  resolvePluginVersionDriftRegistryLag,
  resolvePluginVersionDriftUpdateCommand,
  type PluginVersionDriftReport,
} from "../../plugins/plugin-version-drift.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

type DriftStatusTextStyles = {
  label: (name: string) => string;
  infoText: (value: string) => string;
  warnText: (value: string) => string;
};

/** Deep/shallow human rendering for gathered plugin version drift diagnostics. */
export function printPluginVersionDriftStatus(
  drift: PluginVersionDriftReport,
  opts: {
    deep?: boolean;
    styles: DriftStatusTextStyles;
    printError: (message: string) => void;
    spacer: () => void;
  },
): void {
  const { label, infoText, warnText } = opts.styles;
  defaultRuntime.log(
    warnText(
      terminalText`Plugin version drift: ${drift.drifts.length} active official plugin${
        drift.drifts.length === 1 ? "" : "s"
      } not on gateway ${drift.gatewayVersion}`,
    ),
  );
  if (opts.deep) {
    for (const entry of drift.drifts) {
      const sourceLabel = entry.source === "clawhub" ? "clawhub" : "npm";
      const retainedSelector = formatPluginVersionDriftRetainedNpmSelector(entry);
      const sourceDetail = retainedSelector
        ? `${sourceLabel}, selector ${retainedSelector}`
        : sourceLabel;
      const resolvedTarget =
        entry.targetResolution?.status === "resolved"
          ? `; ${sourceLabel} target ${entry.targetResolution.packageName}@${entry.targetResolution.version}`
          : "";
      // A registry-confirmed version is the only target an update can actually reach.
      const expectedVersion =
        entry.targetResolution?.status === "resolved"
          ? entry.targetResolution.version
          : drift.gatewayVersion;
      defaultRuntime.log(
        `- ${warnText(terminalText`${entry.pluginId}`)}${terminalText`: ${entry.installedVersion} (${sourceDetail}) → expected ${expectedVersion}${resolvedTarget}`}`,
      );
      if (retainedSelector && retainedSelector !== "@latest") {
        defaultRuntime.log(
          infoText(
            terminalText`  Retained ${retainedSelector} keeps that release line; id-only update will not move it to stable.`,
          ),
        );
      }
    }
    const updateCommands: string[] = [];
    const unresolvedRepairs: typeof drift.drifts = [];
    for (const entry of drift.drifts) {
      const command = resolvePluginVersionDriftUpdateCommand(entry);
      const registryLag = resolvePluginVersionDriftRegistryLag(entry);
      if (command) {
        updateCommands.push(formatCliCommand(terminalText`${command}`));
      } else if (!registryLag) {
        unresolvedRepairs.push(entry);
      }
      if (registryLag) {
        defaultRuntime.log(
          terminalText`- ${entry.pluginId}: registry version ${registryLag.registryVersion} is already installed; no release reaches ${registryLag.expectedVersion} yet, so no update command applies.`,
        );
      }
    }
    if (unresolvedRepairs.length > 0) {
      opts.printError("Plugin repair target resolution failed:");
      for (const entry of unresolvedRepairs) {
        const targetResolution = entry.targetResolution;
        const detail =
          targetResolution?.status === "unresolved"
            ? targetResolution.error
            : "npm registry target was not resolved";
        defaultRuntime.error(terminalText`- ${entry.pluginId}: ${detail}`);
      }
      opts.printError(
        "No install command was generated for unresolved plugin targets. Retry gateway status --deep after checking registry availability.",
      );
    }
    if (updateCommands.length === 1 && unresolvedRepairs.length === 0) {
      defaultRuntime.log(
        `${label("Fix:")} ${updateCommands[0]} && ${formatCliCommand("openclaw gateway restart")}.`,
      );
    } else if (updateCommands.length > 0) {
      defaultRuntime.log(`${label("Fix:")} update each drifted plugin:`);
      for (const command of updateCommands) {
        defaultRuntime.log(`- ${command}`);
      }
      if (unresolvedRepairs.length === 0) {
        defaultRuntime.log(`Then run ${formatCliCommand("openclaw gateway restart")}.`);
      }
    }
  } else {
    defaultRuntime.log(
      infoText(
        `Run ${formatCliCommand("openclaw gateway status --deep")} for affected plugin ids and fix commands.`,
      ),
    );
  }
  opts.spacer();
}
