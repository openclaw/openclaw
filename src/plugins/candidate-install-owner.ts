const PLUGIN_CANDIDATE_INSTALL_OWNER = Symbol.for("openclaw.pluginCandidateInstallOwner");

type PluginCandidateInstallOwner = { installOwner?: string; ambiguous?: true };

export function recordPluginCandidateInstallOwner<T extends object>(
  candidate: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return candidate;
  }
  Object.defineProperty(candidate, PLUGIN_CANDIDATE_INSTALL_OWNER, {
    configurable: true,
    enumerable: true,
    value: ambiguous ? { ambiguous: true } : { installOwner },
  });
  return candidate;
}

function readPluginCandidateInstallOwner(
  candidate: object,
): PluginCandidateInstallOwner | undefined {
  return (candidate as { [PLUGIN_CANDIDATE_INSTALL_OWNER]?: PluginCandidateInstallOwner })[
    PLUGIN_CANDIDATE_INSTALL_OWNER
  ];
}

export function resolvePluginCandidateInstallOwner(candidate: object): string | undefined {
  return readPluginCandidateInstallOwner(candidate)?.installOwner;
}

export function isPluginCandidateInstallOwnerAmbiguous(candidate: object): boolean {
  return readPluginCandidateInstallOwner(candidate)?.ambiguous === true;
}
