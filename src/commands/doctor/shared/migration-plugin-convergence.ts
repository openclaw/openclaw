import type { note } from "../../../../packages/terminal-core/src/note.js";
import { createConfigIO } from "../../../config/io.js";
import { discoverConfigWidePluginManifestRegistry } from "../../../config/io.plugin-metadata.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { resolvePluginDoctorContractArtifact } from "../../../plugins/doctor-contract-artifact.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import {
  formatStartupPluginVerificationFailure,
  runStartupUpgradeConvergence,
} from "../../doctor-config-preflight-plugin-verification.js";
import { importShippedPluginInstallConfigForDoctor } from "./plugin-registry-migration.js";

/** Repair the migration contract generation without retiring its config inputs. */
export async function convergeDoctorMigrationPlugins(params: {
  env: NodeJS.ProcessEnv;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  onNote?: typeof note;
}): Promise<void> {
  await withPluginLifecycleLease({}, async () => {
    const snapshot = await createConfigIO({
      env: params.env,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    // Old configs keep the only package locator in plugins.installs. Import
    // records only; the later migration still needs the original source config.
    await importShippedPluginInstallConfigForDoctor(snapshot);
    const convergence = await runStartupUpgradeConvergence({
      cfg: snapshot.sourceConfig,
      env: params.env,
      onCapabilityConsent: params.onCapabilityConsent,
      onNote: params.onNote,
    });
    if (convergence.blockingDiagnostic) {
      throw new Error(formatStartupPluginVerificationFailure(convergence.blockingDiagnostic));
    }
    const migrationUnavailable =
      convergence.quarantinedPlugins.length > 0 &&
      (() => {
        const registry = discoverConfigWidePluginManifestRegistry({
          config: snapshot.sourceConfig,
          env: params.env,
          artifactPreservingReadOnly: true,
        });
        return convergence.quarantinedPlugins.some(({ pluginId }) => {
          const plugin = registry.plugins.find((record) => record.id === pluginId);
          // Missing metadata cannot prove that a failed package owns no migration.
          if (!plugin) {
            return true;
          }
          const declaration = plugin.doctorContract;
          const declaredStateMigrations =
            declaration?.stateMigrations === true || Array.isArray(declaration?.stateMigrations);
          if (
            !declaredStateMigrations &&
            plugin.origin !== "bundled" &&
            plugin.channels.length > 0 &&
            plugin.setupSource
          ) {
            return true;
          }
          if (declaration) {
            return (
              declaration.configRepair ||
              declaration.resolveSessionStoreAgentIds ||
              declaration.sessionRouteStateOwners ||
              declaration.stateMigrations === true ||
              (Array.isArray(declaration.stateMigrations) && declaration.stateMigrations.length > 0)
            );
          }
          // Released plugins predate declarations. Keep their artifact and legacy
          // channel setup contracts protected without executing an unavailable package.
          return Boolean(
            resolvePluginDoctorContractArtifact(plugin) ||
            (plugin.channels.length > 0 && plugin.setupSource),
          );
        });
      })();
    if (migrationUnavailable) {
      throw new Error(
        "Updated plugin payloads are unavailable; run `openclaw update repair` before migrating state.",
      );
    }
  });
}
