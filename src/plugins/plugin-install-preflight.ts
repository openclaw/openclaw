import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";

type PluginInstallPreflightResult =
  | { ok: true; action: "install"; installedPath?: string }
  | {
      ok: true;
      action: "reuse";
      installedId: string;
      installedPath?: string;
      installedIntegrity?: string;
      installedAt?: string;
    }
  | {
      ok: false;
      code: "plugin_version_conflict";
      installedPath?: string;
      installedVersion: string;
    };

/** Resolves one installed plugin by its stable ClawHub package identity. */
export async function resolveInstalledClawHubPlugin(params: { clawhubPackage: string }) {
  const records = await loadInstalledPluginIndexInstallRecords();
  const matches = Object.entries(records).filter(
    ([, record]) =>
      (record.clawhubPackage ??
        parseClawHubPluginSpec(record.spec ?? "")?.name ??
        parseClawHubPluginSpec(record.resolvedSpec ?? "")?.name) === params.clawhubPackage,
  );
  if (matches.length === 0) {
    return { status: "missing" as const };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous" as const,
      pluginIds: matches.map(([pluginId]) => pluginId).toSorted(),
    };
  }
  const [pluginId, record] = matches[0]!;
  return {
    status: "found" as const,
    pluginId,
    record,
    installedVersion: record.resolvedVersion ?? record.version,
  };
}

export async function preflightPluginInstall(params: {
  clawhubPackage: string;
  expectedVersion: string;
}): Promise<PluginInstallPreflightResult> {
  const records = await loadInstalledPluginIndexInstallRecords();
  const installedEntry = Object.entries(records).find(
    ([, record]) =>
      (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name) ===
      params.clawhubPackage,
  );
  const installedId = installedEntry?.[0];
  const installed = installedEntry?.[1];
  const installedVersion = installed?.resolvedVersion ?? installed?.version;
  if (!installedVersion || !installedId) {
    return { ok: true, action: "install" };
  }
  if (installedVersion === params.expectedVersion) {
    return {
      ok: true,
      action: "reuse",
      installedId,
      ...(installed?.installPath ? { installedPath: installed.installPath } : {}),
      ...(installed?.integrity ? { installedIntegrity: installed.integrity } : {}),
      ...(installed?.installedAt ? { installedAt: installed.installedAt } : {}),
    };
  }
  return {
    ok: false,
    code: "plugin_version_conflict",
    ...(installed?.installPath ? { installedPath: installed.installPath } : {}),
    installedVersion,
  };
}
