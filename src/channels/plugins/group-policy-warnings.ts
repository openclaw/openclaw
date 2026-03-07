export function buildOpenGroupPolicyWarning(params: {
  surface: string;
  openBehavior: string;
  remediation: string;
}): string {
  return `- ${params.surface}: groupPolicy="open" ${params.openBehavior}. ${params.remediation}.`;
}

export function buildOpenGroupPolicyRestrictSendersWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} to restrict senders`,
  });
}

export function buildOpenGroupPolicyNoRouteAllowlistWarning(params: {
  surface: string;
  routeAllowlistPath: string;
  routeScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `with no ${params.routeAllowlistPath} allowlist; any ${params.routeScope} can add + ping${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} or configure ${params.routeAllowlistPath}`,
  });
}

export function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  routeAllowlistPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" and configure ${params.routeAllowlistPath}`,
  });
}
