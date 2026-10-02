import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import type { PersistedClawPackageRef } from "./provenance.js";

type InstalledPluginResolver = typeof resolveInstalledClawHubPlugin;

export type ClawPluginUpdateOwner = {
  pluginId: string;
  version: string;
  integrity: string;
  installedAt: string;
  installPath?: string;
};

function freshInstalledPluginResolver(env?: NodeJS.ProcessEnv): InstalledPluginResolver {
  return async ({ clawhubPackage }) =>
    await resolveInstalledClawHubPlugin({
      clawhubPackage,
      loadInstallRecords: async () => {
        const records = readPersistedInstalledPluginIndexInstallRecords({ env });
        if (!records) {
          throw new Error("Installed plugin index is unavailable for an owned Claw Update.");
        }
        return records;
      },
    });
}

async function readPluginUpdateOwner(params: {
  ref: string;
  env?: NodeJS.ProcessEnv;
  resolveInstalled?: InstalledPluginResolver;
}): Promise<ClawPluginUpdateOwner | null> {
  const installed = await (params.resolveInstalled ?? freshInstalledPluginResolver(params.env))({
    clawhubPackage: params.ref,
  });
  if (installed.status !== "found" || installed.record.source !== "clawhub") {
    return null;
  }
  const integrity = installed.record.integrity
    ? normalizeClawHubSha256Integrity(installed.record.integrity)
    : null;
  const installedAt = installed.record.installedAt;
  if (
    !installed.installedVersion ||
    !integrity ||
    !installedAt ||
    !Number.isFinite(Date.parse(installedAt))
  ) {
    return null;
  }
  return {
    pluginId: installed.pluginId,
    version: installed.installedVersion,
    integrity,
    installedAt,
    ...(installed.record.installPath ? { installPath: installed.record.installPath } : {}),
  };
}

export async function captureOwnedClawPluginUpdate(params: {
  previous: PersistedClawPackageRef;
  env?: NodeJS.ProcessEnv;
  resolveInstalled?: InstalledPluginResolver;
}): Promise<ClawPluginUpdateOwner | null> {
  const owner = await readPluginUpdateOwner({
    ref: params.previous.ref,
    env: params.env,
    resolveInstalled: params.resolveInstalled,
  });
  const expectedIntegrity = normalizeClawHubSha256Integrity(params.previous.integrity);
  if (
    !owner ||
    !expectedIntegrity ||
    owner.version !== params.previous.version ||
    owner.integrity !== expectedIntegrity ||
    Date.parse(owner.installedAt) > params.previous.updatedAtMs
  ) {
    return null;
  }
  return owner;
}

export async function assertOwnedClawPluginUpdateCurrent(params: {
  ref: string;
  expected: ClawPluginUpdateOwner;
  env?: NodeJS.ProcessEnv;
  resolveInstalled?: InstalledPluginResolver;
}): Promise<void> {
  const current = await readPluginUpdateOwner(params);
  if (
    !current ||
    current.pluginId !== params.expected.pluginId ||
    current.version !== params.expected.version ||
    current.integrity !== params.expected.integrity ||
    current.installedAt !== params.expected.installedAt ||
    current.installPath !== params.expected.installPath
  ) {
    throw new Error(
      `Plugin ${JSON.stringify(params.ref)} ownership changed before artifact commit.`,
    );
  }
}
