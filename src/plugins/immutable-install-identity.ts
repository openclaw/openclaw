import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

/**
 * Registry npm installs are replaced through a new install record, never edited in place.
 * Local, archive, and path installs can change without one, so they have no identity.
 */
export function resolveImmutableInstallIdentity(
  origin: PluginOrigin,
  installOwner: string | undefined,
  installRecords: Readonly<Record<string, PluginInstallRecord>>,
): string | undefined {
  const install = installOwner ? installRecords[installOwner] : undefined;
  if (origin !== "global" || install?.source !== "npm" || !install.integrity) {
    return undefined;
  }
  return JSON.stringify([
    installOwner,
    install.installPath ?? "",
    install.resolvedSpec ?? install.spec ?? "",
    install.integrity,
    install.installedAt ?? "",
  ]);
}
