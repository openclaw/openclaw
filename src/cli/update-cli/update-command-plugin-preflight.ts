import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { collectConfiguredNpmPluginTargets } from "../../commands/doctor/shared/missing-configured-plugin-install.targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveNpmSpecMetadata } from "../../infra/install-source-utils.js";
import { readInstalledPackageManifest } from "../../infra/package-update-utils.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import { resolveNpmInstallSpecsForUpdateChannel } from "../../plugins/install-channel-specs.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { checkMinHostVersion } from "../../plugins/min-host-version.js";
import {
  resolvePackagePluginApiRange,
  satisfiesPluginApiRange,
} from "../../plugins/package-compat.js";
import { UpdatePreMutationError } from "./shared.js";
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

/** Block only a declared incompatibility that an available plugin update cannot repair. */
export async function preflightConfiguredNpmPluginTargets(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targetVersion: string | null;
  channel: UpdateChannel;
  timeoutMs: number;
}): Promise<void> {
  const targetVersion = params.targetVersion;
  if (!targetVersion) {
    return;
  }
  await withOwnedManagedUpdateEnv(params.env, async () => {
    const installRecords = await loadInstalledPluginIndexInstallRecords({ env: params.env });
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
      const requirement = incompatibleRequirement(manifest?.openclaw, targetVersion, true);
      // Availability and retention belong to post-core sync; a healthy plugin needs no network gate.
      if (!requirement || typeof manifest?.version !== "string") {
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
            continue;
          }
          failure = `resolved plugin requires ${candidateRequirement}`;
        }
      } catch (error) {
        failure = `registry could not be reached: ${formatErrorMessage(error)}`;
      }
      throw new UpdatePreMutationError(
        "plugin-incompatible",
        `Update refused: Plugin "${target.pluginId}" (installed ${manifest.version}) requires ${requirement} and would not load on core ${targetVersion}. Cannot resolve a compatible ${requiredSpec}: ${failure}. Retry when the registry is reachable, pin a compatible plugin version with \`openclaw plugins update <package>@<compatible-version>\`, disable it with \`openclaw plugins disable ${target.pluginId}\`, or wait for a compatible release.`,
      );
    }
  });
}
