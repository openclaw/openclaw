import { note } from "../../packages/terminal-core/src/note.js";
import {
  SERVICE_AUDIT_CODES,
  type ServiceConfigAudit,
  type ServiceConfigIssue,
} from "../daemon/service-audit.js";
import { SERVICE_PROXY_ENV_KEYS } from "../daemon/service-env.js";
import { normalizeServiceEnvKey } from "../daemon/service-managed-env.js";
import {
  hasGatewayServiceEnvironmentOverride,
  type GatewayServiceCommandConfig,
  type GatewayServiceInstallArgs,
} from "../daemon/service-types.js";

export function formatServiceConfigIssues(issues: ServiceConfigIssue[]): string[] {
  return issues.map(({ message, detail }) => `- ${message}${detail ? ` (${detail})` : ""}`);
}

export function reportServiceDefinitionDrift(audit: ServiceConfigAudit) {
  const messages = [
    ...(audit.definitionDrift ?? []).map((fact) => fact.message),
    ...(audit.definitionDriftError ? [audit.definitionDriftError] : []),
  ];
  if (messages.length > 0) {
    note(messages.map((message) => `- ${message}`).join("\n"), "Gateway service definition");
  }
}

/** Installation repair cannot implicitly approve other service-definition changes. */
export function isServiceInstallationOnlyRepair(audit: ServiceConfigAudit): boolean {
  return (
    !audit.definitionDriftError &&
    !audit.definitionDrift?.length &&
    audit.issues.every((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch)
  );
}

export function hasRepairableServiceDefinitionDrift(audit: ServiceConfigAudit): boolean {
  return (
    !audit.definitionDriftError &&
    audit.definitionDrift?.some((finding) => finding.kind === "outdated") === true &&
    !audit.definitionDrift.some((finding) => finding.kind === "unknown-edit")
  );
}

export function isPreservedLaunchdTimeoutWarning(audit: ServiceConfigAudit): boolean {
  return (
    audit.issues.every((issue) => issue.code === "launchd-stop-timeout") &&
    audit.definitionDrift?.some(
      (finding) => finding.kind === "preserved" && finding.key === "ExitTimeOut",
    ) === true
  );
}

/** Native policy repair must not auto-approve unrelated command or credential changes. */
export function isServiceDefinitionOnlyRepair(audit: ServiceConfigAudit): boolean {
  const policyCodes: ReadonlySet<string> = new Set([
    SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
    SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
    SERVICE_AUDIT_CODES.systemdRestartSec,
    SERVICE_AUDIT_CODES.systemdKillModeProcessOrNone,
    SERVICE_AUDIT_CODES.systemdKillModeControlGroup,
    SERVICE_AUDIT_CODES.systemdStopTimeout,
    "launchd-run-at-load",
    "launchd-keep-alive",
    "launchd-stop-timeout",
    "launchd-env-wrapper-outdated",
  ]);
  return audit.issues.every((issue) => policyCodes.has(issue.code));
}

export function isOperatorOwnedEnvironmentIssue(
  issue: { code: string; environmentKeys?: readonly string[] },
  command: GatewayServiceCommandConfig,
  environmentValueSources: GatewayServiceInstallArgs["environmentValueSources"],
): boolean {
  const hasOverride = (keys: readonly string[]) =>
    hasGatewayServiceEnvironmentOverride(command, keys, { environmentValueSources });
  switch (issue.code) {
    case SERVICE_AUDIT_CODES.gatewayPathMissing:
    case SERVICE_AUDIT_CODES.gatewayPathMissingDirs:
    case SERVICE_AUDIT_CODES.gatewayPathNonMinimal:
      return hasOverride(["PATH"]);
    case SERVICE_AUDIT_CODES.gatewayTokenEmbedded:
    case SERVICE_AUDIT_CODES.gatewayTokenMismatch:
    case SERVICE_AUDIT_CODES.gatewayTokenDrift:
      return hasOverride(["OPENCLAW_GATEWAY_TOKEN"]);
    case SERVICE_AUDIT_CODES.gatewayPasswordEmbedded:
      return hasOverride(["OPENCLAW_GATEWAY_PASSWORD"]);
    case SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded:
      return hasGatewayServiceEnvironmentOverride(command, issue.environmentKeys ?? [], {
        environmentValueSources,
        normalizeKey: normalizeServiceEnvKey,
      });
    case SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded:
      return hasGatewayServiceEnvironmentOverride(
        command,
        (issue.environmentKeys ?? []).filter((key) =>
          SERVICE_PROXY_ENV_KEYS.some((proxyKey) => proxyKey === key),
        ),
        { ignoreResets: true },
      );
    default:
      return false;
  }
}
