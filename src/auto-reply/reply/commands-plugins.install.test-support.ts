import type { persistPluginInstall } from "../../plugins/install-persistence.js";
import { metadataSnapshot } from "../../plugins/management-service.test-helpers.js";

export function clawHubInstallResult(pluginId: string, clawhubPackage: string, official = false) {
  const version = "1.2.3";
  return {
    ok: true,
    pluginId,
    targetDir: `/tmp/${pluginId}`,
    version,
    ...(official ? { extensions: ["index.js"], packageName: clawhubPackage } : {}),
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage,
      clawhubFamily: "code-plugin",
      version,
      ...(official
        ? {
            clawhubChannel: "official",
            integrity: "sha512-demo",
            resolvedAt: "2026-03-22T12:00:00.000Z",
          }
        : {}),
    },
  };
}

/** These command fixtures stub persistence; project only its recorded install arguments. */
export function committedPluginMetadata(
  params: Parameters<typeof persistPluginInstall>[0] | undefined,
) {
  if (!params) {
    throw new Error("Expected plugin persistence before installed metadata inspection");
  }
  return metadataSnapshot({
    id: params.pluginId,
    name: params.pluginId,
    origin: "global",
    enabled: true,
    installRecord: params.install,
  });
}
