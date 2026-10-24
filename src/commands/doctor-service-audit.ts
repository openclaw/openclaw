import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  SERVICE_AUDIT_CODES,
  type ServiceConfigAudit,
  type ServiceConfigIssue,
} from "../daemon/service-audit.js";
import { SERVICE_PROXY_ENV_KEYS } from "../daemon/service-env.js";
import {
  gatewayServiceCommandMatchesRoot,
  type GatewayServiceLayoutSummary,
} from "../daemon/service-layout.js";
import { normalizeServiceEnvKey } from "../daemon/service-managed-env.js";
import {
  hasGatewayServiceEnvironmentOverride,
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
  type GatewayServiceInstallArgs,
} from "../daemon/service-types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayInstallPlan } from "./daemon-install-plan.shared.js";

export function formatServiceConfigIssues(issues: ServiceConfigIssue[]): string[] {
  return issues.map(({ message, detail }) => `- ${message}${detail ? ` (${detail})` : ""}`);
}

/** Keep source-checkout and native audit findings in one panel. */
export function reportGatewayServiceConfigAudit(
  audit: ServiceConfigAudit,
  layout: GatewayServiceLayoutSummary | undefined,
  definitionRepair: boolean,
): string | null {
  const sourceCheckoutWarning = layout?.entrypointSourceCheckout
    ? [
        `Gateway service entrypoint resolves to a source checkout: ${layout.packageRootReal ?? layout.packageRoot ?? layout.entrypointReal ?? layout.entrypoint}.`,
        `Run \`${formatCliCommand("openclaw gateway install --force")}\` from the intended package install to replace the gateway service definition.`,
      ].join("\n")
    : null;
  const sourceCheckoutWarningToShow = audit.issues.some(
    (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
  )
    ? null
    : sourceCheckoutWarning;
  if (audit.issues.length === 0 && !definitionRepair) {
    if (sourceCheckoutWarningToShow !== null) {
      note(sourceCheckoutWarningToShow, "Gateway service config");
    }
    return sourceCheckoutWarningToShow;
  }
  note(
    [
      ...(sourceCheckoutWarningToShow !== null ? [sourceCheckoutWarningToShow, ""] : []),
      ...formatServiceConfigIssues(audit.issues),
    ].join("\n"),
    "Gateway service config",
  );
  return sourceCheckoutWarningToShow;
}

/** Describe the selected install plan without changing runtime or launcher policy. */
export function formatGatewayServiceRepairPreview(params: {
  command: GatewayServiceCommandConfig;
  managedDefinition: GatewayServiceCommandConfig;
  plan: Pick<GatewayServiceInstallArgs, "programArguments" | "environment">;
  currentLayout: GatewayServiceLayoutSummary | undefined;
  plannedLayout: GatewayServiceLayoutSummary | undefined;
  missingSystemNode: boolean;
  runtimeIssues: readonly ServiceConfigIssue[];
  definitionDrift: ServiceConfigAudit["definitionDrift"];
}): { preview: string; unresolvedFindings: HealthFinding[] } {
  const unresolvedFindings: HealthFinding[] = [];
  if (params.missingSystemNode) {
    const runtimeFailed = params.runtimeIssues.some(
      (issue) =>
        issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNode ||
        issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun,
    );
    unresolvedFindings.push({
      checkId: "core/doctor/gateway-service",
      severity: runtimeFailed ? "error" : "warning",
      category: runtimeFailed ? "fix-now" : "recommended",
      message: `No supported system Node is available; this repair retains ${params.plan.programArguments[0]}.`,
      fixHint: `Install system Node ${SUPPORTED_NODE_VERSIONS} and rerun Doctor to resolve the runtime finding.`,
      docsUrl: "https://docs.openclaw.ai/cli/doctor/checks#gateway-and-service-repairs",
    });
  }
  if (params.plannedLayout?.entrypointSourceCheckout) {
    unresolvedFindings.push({
      checkId: "core/doctor/gateway-service",
      severity: "warning",
      category: "recommended",
      message: "This repair retains a source-checkout entrypoint.",
      fixHint: `Run \`${formatCliCommand("openclaw gateway install --force")}\` from the intended package install to replace it.`,
      docsUrl: "https://docs.openclaw.ai/cli/doctor/checks#gateway-and-service-repairs",
    });
  }
  const preview = [
    `Runtime: ${params.managedDefinition.programArguments[0]} -> ${params.plan.programArguments[0]}`,
    `Entrypoint: ${params.currentLayout?.entrypoint ?? "not identified"} -> ${params.plannedLayout?.entrypoint ?? "not identified"}`,
    `PATH: ${params.command.environment?.PATH ?? "not set"} -> ${params.plan.environment?.PATH ?? "not set"}`,
    ...(params.definitionDrift ?? []).flatMap((finding) =>
      finding.kind === "outdated" &&
      (finding.key === "ExitTimeOut" || finding.key === "TimeoutStopSec")
        ? [
            `Shutdown budget (${finding.key}): ${String(finding.current)} -> ${String(finding.expected)}`,
          ]
        : [],
    ),
    ...unresolvedFindings.map((finding) => `Will remain: ${finding.message} ${finding.fixHint}`),
  ].join("\n");
  return { preview, unresolvedFindings };
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
    SERVICE_AUDIT_CODES.gatewayEgressProxyEnvEmbedded,
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

/** The install plan retains pins/wrappers; only a changed, owned Node runtime is repairable. */
export async function canRepairRuntime(
  audit: ServiceConfigAudit,
  command: GatewayServiceCommandConfig,
  plan: GatewayInstallPlan,
  layout: GatewayServiceLayoutSummary | undefined,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const runtimeCodes: ReadonlySet<string> = new Set([
    SERVICE_AUDIT_CODES.gatewayRuntimeNode,
    SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
    SERVICE_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
    SERVICE_AUDIT_CODES.gatewayPathMissing,
    SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
    SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
  ]);
  return (
    !layout?.entrypointSourceCheckout &&
    !hasGatewayServiceLauncherOverride(command) &&
    plan.runtime === "node" &&
    plan.programArguments[0] !==
      resolveManagedGatewayServiceCommand(command)?.programArguments[0] &&
    audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNode) &&
    audit.issues.every((issue) => runtimeCodes.has(issue.code)) &&
    !audit.definitionDriftError &&
    !audit.definitionDrift?.some(
      (finding) =>
        finding.kind === "unknown-edit" &&
        !(
          platform === "linux" &&
          finding.sourcePath &&
          finding.sourcePath !== command.sourcePath &&
          command.definitionPaths?.includes(finding.sourcePath)
        ),
    ) &&
    (await gatewayServiceCommandMatchesRoot(layout?.packageRootReal, command)) === true
  );
}

export function isOperatorOwnedServiceIssue(
  issue: { code: string; environmentKeys?: readonly string[] },
  command: GatewayServiceCommandConfig,
  environmentValueSources: GatewayServiceInstallArgs["environmentValueSources"],
): boolean {
  const hasOverride = (keys: readonly string[]) =>
    hasGatewayServiceEnvironmentOverride(command, keys, { environmentValueSources });
  switch (issue.code) {
    case SERVICE_AUDIT_CODES.gatewayRuntimeNode:
      return hasGatewayServiceLauncherOverride(command);
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
    case SERVICE_AUDIT_CODES.gatewayEgressProxyEnvEmbedded:
      return hasOverride(issue.environmentKeys ?? []);
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

export function reportGatewayServiceFailure(
  message: string,
  runtime: RuntimeEnv,
  onFinding?: (finding: HealthFinding) => void,
): void {
  if (onFinding) {
    onFinding({
      checkId: "core/doctor/gateway-service",
      severity: "error",
      category: "fix-now",
      message,
      fixHint:
        "Run openclaw gateway status --deep from the intended install/profile. Resolve the reported permission or configuration error, then rerun openclaw doctor --fix in an interactive terminal.",
      docsUrl: "https://docs.openclaw.ai/cli/doctor/checks#gateway-and-service-repairs",
    });
  } else {
    runtime.error(message);
  }
}

export function reportUnresolvedGatewayServiceFindings(
  findings: readonly HealthFinding[],
  onFinding?: (finding: HealthFinding) => void,
): void {
  if (!onFinding) {
    note(
      findings.map((finding) => `${finding.message} ${finding.fixHint}`).join("\n"),
      "Gateway service findings still unresolved",
    );
    return;
  }
  for (const finding of findings) {
    onFinding(finding);
  }
}

export function noteDeclinedGatewayServiceRepair(
  needsConfigWrite: boolean,
  sourceCheckoutWarningToShow: string | null,
): void {
  if (needsConfigWrite) {
    note(
      "Skipped Gateway token preservation and service repair. Rerun `openclaw doctor --fix` in an interactive terminal to approve saving a store SecretRef in gateway.auth.token.",
      "Gateway service config",
    );
  }
  if (sourceCheckoutWarningToShow === null) {
    note(
      `Run \`${formatCliCommand("openclaw gateway install --force")}\` when you want to replace the gateway service definition.`,
      "Gateway service config",
    );
  }
}
