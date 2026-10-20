import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";

/**
 * Registry npm installs are replaced through a new install record, never edited in place.
 * Local, archive, and path installs can change without one, so they have no identity.
 */
export function resolveImmutableInstallIdentity(
  candidate: PluginCandidate,
  installRecords: Readonly<Record<string, PluginInstallRecord>>,
): string | undefined {
  const installOwner = resolvePluginCandidateInstallOwner(candidate);
  const install = installOwner ? installRecords[installOwner] : undefined;
  if (candidate.origin !== "global" || install?.source !== "npm" || !install.integrity) {
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
