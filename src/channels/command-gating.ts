export type CommandAuthorizer = {
  /** Whether this authorization source has a configured rule to evaluate. */
  configured: boolean;
  /** Whether the configured rule allows the current sender/request. */
  allowed: boolean;
};

/** Fallback command policy when access-group checks are disabled. */
export type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";

/** Resolves whether any configured authorizer permits a control command. */
export function resolveCommandAuthorizedFromAuthorizers(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    // In configured mode, absence of any configured authorizer keeps old open
    // behavior; once configured, at least one matching authorizer must allow.
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

/** Resolves both authorization and whether a text control command should be blocked. */
export function resolveControlCommandGate(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: params.authorizers,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

/** Convenience gate for channels with two independent text authorization sources. */
export function resolveDualTextControlCommandGate(params: {
  useAccessGroups: boolean;
  primaryConfigured: boolean;
  primaryAllowed: boolean;
  secondaryConfigured: boolean;
  secondaryAllowed: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  return resolveControlCommandGate({
    useAccessGroups: params.useAccessGroups,
    authorizers: [
      { configured: params.primaryConfigured, allowed: params.primaryAllowed },
      { configured: params.secondaryConfigured, allowed: params.secondaryAllowed },
    ],
    allowTextCommands: true,
    hasControlCommand: params.hasControlCommand,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
}
