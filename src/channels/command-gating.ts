export type CommandAuthorizer = {
  /** True when this authorizer has policy data for the current sender/context. */
  configured: boolean;
  /** True when the configured policy allows the control command. */
  allowed: boolean;
};

/** Fallback policy used when access groups are disabled for a channel/account. */
export type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";

/** Resolves command authorization from one or more configured policy sources. */
export function resolveCommandAuthorizedFromAuthorizers(params: {
  /** True when configured access groups should be enforced. */
  useAccessGroups: boolean;
  /** Candidate authorizers; any configured allow grants access. */
  authorizers: CommandAuthorizer[];
  /** Fallback behavior when access groups are disabled. Defaults to allow. */
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
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    // "configured" preserves legacy permissive behavior until a concrete authorizer exists.
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

/** Returns both command authorization and whether a text control command must be blocked. */
export function resolveControlCommandGate(params: {
  /** True when configured access groups should be enforced. */
  useAccessGroups: boolean;
  /** Candidate authorizers checked before allowing text control commands. */
  authorizers: CommandAuthorizer[];
  /** True when text commands are enabled for this inbound surface. */
  allowTextCommands: boolean;
  /** True when the inbound text contains a recognized control command. */
  hasControlCommand: boolean;
  /** Fallback behavior when access groups are disabled. Defaults to allow. */
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

/** Convenience wrapper for text command gates with primary and secondary authorizers. */
export function resolveDualTextControlCommandGate(params: {
  /** True when configured access groups should be enforced. */
  useAccessGroups: boolean;
  /** True when the primary authorizer has policy data for this sender/context. */
  primaryConfigured: boolean;
  /** True when the primary authorizer allows the command. */
  primaryAllowed: boolean;
  /** True when the secondary authorizer has policy data for this sender/context. */
  secondaryConfigured: boolean;
  /** True when the secondary authorizer allows the command. */
  secondaryAllowed: boolean;
  /** True when the inbound text contains a recognized control command. */
  hasControlCommand: boolean;
  /** Fallback behavior when access groups are disabled. Defaults to allow. */
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
