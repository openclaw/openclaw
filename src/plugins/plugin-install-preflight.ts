import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../cli/plugin-install-config-policy.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";

type PluginInstallPreflightResult =
  | { ok: true; action: "install"; request: PluginInstallRequestContext }
  | {
      ok: true;
      action: "reuse";
      request: PluginInstallRequestContext;
      installedId: string;
      installedVersion: string;
      installedIntegrity?: string;
    }
  | {
      ok: false;
      code: "plugin_version_conflict";
      request: PluginInstallRequestContext;
      installedVersion: string;
      expectedVersion: string;
    }
  | { ok: false; code: "invalid_plugin_spec"; error: string };

export async function preflightPluginInstall(params: {
  clawhubPackage: string;
  rawSpec: string;
  expectedVersion: string;
  marketplace?: string;
  loadInstallRecords?: typeof loadInstalledPluginIndexInstallRecords;
}): Promise<PluginInstallPreflightResult> {
  const resolved = resolvePluginInstallRequestContext({
    rawSpec: params.rawSpec,
    ...(params.marketplace ? { marketplace: params.marketplace } : {}),
    installKind: "plugin",
  });
  if (!resolved.ok) {
    return { ok: false, code: "invalid_plugin_spec", error: resolved.error };
  }

  const records = await (params.loadInstallRecords ?? loadInstalledPluginIndexInstallRecords)();
  const installedEntry = Object.entries(records).find(
    ([, record]) =>
      (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name) ===
      params.clawhubPackage,
  );
  const installedId = installedEntry?.[0];
  const installed = installedEntry?.[1];
  const installedVersion = installed?.resolvedVersion ?? installed?.version;
  if (!installedVersion || !installedId) {
    return { ok: true, action: "install", request: resolved.request };
  }
  if (installedVersion === params.expectedVersion) {
    return {
      ok: true,
      action: "reuse",
      request: resolved.request,
      installedId,
      installedVersion,
      ...(installed?.integrity ? { installedIntegrity: installed.integrity } : {}),
    };
  }
  return {
    ok: false,
    code: "plugin_version_conflict",
    request: resolved.request,
    installedVersion,
    expectedVersion: params.expectedVersion,
  };
}
