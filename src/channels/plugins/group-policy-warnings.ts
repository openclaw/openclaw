import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../../config/runtime-group-policy.js";
import type { GroupPolicy } from "../../config/types.base.js";

type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];

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

export function collectOpenGroupPolicyRestrictSendersWarnings(
  params: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0] & {
    groupPolicy: "open" | "allowlist" | "disabled";
  },
): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  return [buildOpenGroupPolicyRestrictSendersWarning(params)];
}

export function collectAllowlistProviderRestrictSendersWarnings(
  params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
  } & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">,
): string[] {
  return collectAllowlistProviderGroupPolicyWarnings({
    cfg: params.cfg,
    providerConfigPresent: params.providerConfigPresent,
    configuredGroupPolicy: params.configuredGroupPolicy,
    collect: (groupPolicy) =>
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy,
        surface: params.surface,
        openScope: params.openScope,
        groupPolicyPath: params.groupPolicyPath,
        groupAllowFromPath: params.groupAllowFromPath,
        mentionGated: params.mentionGated,
      }),
  });
}

export function collectAllowlistProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[] {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy ?? undefined,
    defaultGroupPolicy,
  });
  return params.collect(groupPolicy);
}

export function collectOpenProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[] {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy ?? undefined,
    defaultGroupPolicy,
  });
  return params.collect(groupPolicy);
}

export function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)];
  }
  return [buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)];
}

export function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)];
  }
  return [buildOpenGroupPolicyWarning(params.missingRouteAllowlist)];
}
