import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { collectConfiguredNpmPluginTargets } from "../../commands/doctor/shared/missing-configured-plugin-install.targets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  packNpmSpecToArchive,
  resolveNpmSpecMetadata,
  withInstallWorkspace,
} from "../../infra/install-source-utils.js";
import { readInstalledPackageManifest } from "../../infra/package-update-utils.js";
import { resolveRegistryUpdateChannel } from "../../infra/update-channels.js";
import {
  NpmChannelResolutionError,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../../plugins/install-channel-specs.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { checkMinHostVersion } from "../../plugins/min-host-version.js";
import {
  resolvePackagePluginApiRange,
  satisfiesPluginApiRange,
} from "../../plugins/package-compat.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { PluginUpdateWarning } from "./update-command-plugins-internals.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

function incompatibleRequirement(
  metadata: unknown,
  targetVersion: string,
  installed = false,
): string | undefined {
  const api = resolvePackagePluginApiRange(metadata);
  if (api.ok && api.range && !satisfiesPluginApiRange(targetVersion, api.range)) {
    return `plugin API ${api.range}`;
  }
  const install = isRecord(metadata) && isRecord(metadata.install) ? metadata.install : undefined;
  const host = checkMinHostVersion({
    currentVersion: targetVersion,
    minHostVersion: install?.minHostVersion,
    allowLegacyBareSemver: installed,
  });
  return !host.ok && host.kind === "incompatible" ? `OpenClaw ${host.requirement.raw}` : undefined;
}

/** Report unavailable replacements without vetoing the core package update. */
export async function preflightConfiguredNpmPluginTargets(
  params: Omit<Parameters<typeof collectConfiguredNpmPluginTargets>[0], "targetVersion"> & {
    targetVersion: string | null;
    timeoutMs: number;
    /** Download only; normal post-core installation still owns every activation decision. */
    prefetch?: boolean;
  },
): Promise<PluginUpdateWarning[]> {
  return await withCommandProcessScope(async () => {
    const targetVersion = params.targetVersion;
    if (!targetVersion) {
      return [];
    }
    return await withOwnedManagedUpdateEnv(params.env, async () => {
      const warnings: PluginUpdateWarning[] = [];
      // A configured operator policy owns admission before package side effects. Leave its
      // download with the installer rather than running policy commands during preflight.
      const prefetch = params.prefetch && params.config.security?.installPolicy?.enabled !== true;
      const installRecords =
        params.installRecords ??
        (await loadInstalledPluginIndexInstallRecords({ env: params.env }));
      const targets = await collectConfiguredNpmPluginTargets({
        ...params,
        targetVersion,
        installRecords,
        channel: resolveRegistryUpdateChannel({
          configChannel: params.channel,
          currentVersion: targetVersion,
        }),
      });
      for (const target of targets) {
        const record = installRecords[target.pluginId];
        const manifest = record?.installPath
          ? readInstalledPackageManifest(record.installPath)
          : undefined;
        const installedVersion =
          typeof manifest?.version === "string" ? manifest.version : undefined;
        const requirement = incompatibleRequirement(manifest?.openclaw, targetVersion, true);
        // Preview keeps its metadata-only contract. Downloads are best-effort preparation, not admission.
        if (!prefetch && (!requirement || !installedVersion)) {
          continue;
        }
        let requiredSpec = target.spec;
        let failure: string;
        try {
          const selected = await resolveNpmInstallSpecsForUpdateChannel({
            ...target,
            timeoutMs: params.timeoutMs,
          });
          requiredSpec = selected.installSpec;
          const resolution = selected.npmResolution
            ? { ok: true as const, metadata: selected.npmResolution }
            : await resolveNpmSpecMetadata({ spec: requiredSpec, timeoutMs: params.timeoutMs });
          if (!resolution.ok) {
            failure =
              resolution.category === "metadata-env"
                ? `registry could not be reached: ${resolution.error}`
                : resolution.error;
          } else {
            const candidateRequirement = incompatibleRequirement(
              resolution.metadata.packageOpenClaw,
              targetVersion,
            );
            if (!candidateRequirement) {
              const metadata = resolution.metadata;
              if (
                !prefetch ||
                !metadata.resolvedSpec ||
                !metadata.integrity ||
                metadata.version === installedVersion
              ) {
                continue;
              }
              const pinnedSpec = metadata.resolvedSpec;
              // npm owns the integrity-addressed transport cache across the fresh post-core
              // process. The private pack output is disposable; no install, extraction or hooks
              // run here. A changed plan or evicted cache uses the normal download path.
              try {
                const packed = await withInstallWorkspace("openclaw-plugin-prefetch-", (cwd) =>
                  packNpmSpecToArchive({
                    spec: pinnedSpec,
                    timeoutMs: params.timeoutMs,
                    workTimeoutMs: params.timeoutMs,
                    cwd,
                  }),
                );
                if (
                  packed.ok &&
                  packed.metadata.resolvedSpec === pinnedSpec &&
                  packed.metadata.integrity === metadata.integrity
                ) {
                  continue;
                }
                failure = packed.ok
                  ? "Downloaded archive does not match the selected version and integrity"
                  : packed.error;
              } catch (error) {
                if (hasCommandProcessCleanupError(error)) {
                  throw error;
                }
                failure = `download preparation failed: ${formatErrorMessage(error)}`;
              }
            } else {
              failure = `resolved plugin requires ${candidateRequirement}`;
            }
          }
        } catch (error) {
          if (
            hasCommandProcessCleanupError(error) ||
            !(error instanceof NpmChannelResolutionError)
          ) {
            throw error;
          }
          failure = `registry could not be reached: ${formatErrorMessage(error)}`;
        }
        warnings.push({
          pluginId: target.pluginId,
          reason: `${requirement && installedVersion ? `Installed ${installedVersion} requires ${requirement}; ` : ""}${requiredSpec}: ${failure}`,
          message: `Plugin "${target.pluginId}" update ${prefetch ? "download" : "availability"} could not be confirmed; the core update can continue.`,
          guidance: [],
        });
      }
      return warnings;
    });
  });
}
