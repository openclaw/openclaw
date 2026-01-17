export type CommandAuthorizer = {
  configured: boolean;
  allowed: boolean;
};

export type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";

export function resolveCommandAuthorizedFromAuthorizers(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") return true;
    if (mode === "deny") return false;
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) return true;
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}
