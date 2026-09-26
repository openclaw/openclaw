/** Audits installed daemon service definitions for drift and repair candidates. */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveInlineCommandMatch } from "../infra/shell-inline-command.js";
import { POSIX_SHELL_WRAPPERS } from "../infra/shell-wrapper-resolution.js";
import { detectRespawnSupervisor } from "../infra/supervisor-markers.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { auditLaunchdDefinition } from "./service-audit-launchd.js";
import { auditGatewayInstallPreservation } from "./service-audit-preservation.js";
import { auditGatewayRuntime, SERVICE_RUNTIME_AUDIT_CODES } from "./service-audit-runtime.js";
import { auditScheduledTaskDefinition } from "./service-audit-schtasks.js";
import { auditSystemdUnit, SYSTEMD_SERVICE_AUDIT_CODES } from "./service-audit-systemd.js";
import type {
  GatewayServiceCommand,
  GatewayServiceExpectedCommand,
  ServiceConfigIssue,
  ServiceDefinitionDrift,
} from "./service-audit-types.js";
import { getMinimalServicePathPartsFromEnv, SERVICE_PROXY_ENV_KEYS } from "./service-env.js";
import {
  collectInlineManagedServiceEnvKeys,
  collectInlineServiceEnvKeys,
  hasInlineEnvironmentSource,
  isEnvironmentFileOnlySource,
  normalizeServiceEnvKey,
  readEnvironmentValueSource,
  readManagedServiceEnvKeysFromEnvironment,
} from "./service-managed-env.js";
import { isNonMinimalServicePathEntry, normalizeServicePathEntry } from "./service-path-policy.js";

export type {
  GatewayServiceCommand,
  GatewayServiceExpectedCommand,
  ServiceConfigIssue,
  ServiceDefinitionDrift,
} from "./service-audit-types.js";

export type ServiceConfigAudit = {
  ok: boolean;
  issues: ServiceConfigIssue[];
  runtimeNote?: string;
  definitionDrift?: ServiceDefinitionDrift[];
  definitionDriftError?: string;
};
export const SERVICE_AUDIT_CODES = {
  ...SERVICE_RUNTIME_AUDIT_CODES,
  ...SYSTEMD_SERVICE_AUDIT_CODES,
  gatewayCommandMissing: "gateway-command-missing",
  gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
  gatewayPathMissing: "gateway-path-missing",
  gatewayPathMissingDirs: "gateway-path-missing-dirs",
  gatewayPathNonMinimal: "gateway-path-nonminimal",
  gatewayTokenEmbedded: "gateway-token-embedded",
  gatewayPasswordEmbedded: "gateway-password-embedded",
  gatewayManagedEnvEmbedded: "gateway-managed-env-embedded",
  gatewayPortMismatch: "gateway-port-mismatch",
  gatewayProxyEnvEmbedded: "gateway-proxy-env-embedded",
  gatewayTokenMismatch: "gateway-token-mismatch",
  gatewayTokenDrift: "gateway-token-drift",
  gatewayEnvDrift: "gateway-env-drift",
  launchdKeepAlive: "launchd-keep-alive",
  launchdRunAtLoad: "launchd-run-at-load",
} as const;

/** Returns whether audit issues require migrating a daemon to a stable Node runtime. */
export function needsNodeRuntimeMigration(issues: ServiceConfigIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun ||
      issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNode ||
      issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
  );
}

const POSIX_SERVICE_INLINE_COMMAND_FLAGS = new Set(["-c"]);

function isOpaquePosixShellInlineCommand(programArguments: string[]): boolean {
  const executable = programArguments[0]?.trim();
  const shellName = executable ? path.posix.basename(executable).toLowerCase() : "";
  if (!POSIX_SHELL_WRAPPERS.has(shellName)) {
    return false;
  }
  return (
    resolveInlineCommandMatch(programArguments, POSIX_SERVICE_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
    }).command !== null
  );
}

function auditGatewayCommand(programArguments: string[] | undefined, issues: ServiceConfigIssue[]) {
  if (!programArguments || programArguments.length === 0) {
    return;
  }
  if (!programArguments.includes("gateway") && !isOpaquePosixShellInlineCommand(programArguments)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayCommandMissing,
      message: "Service command does not include the gateway subcommand",
      level: "aggressive",
    });
  }
}

function readGatewayServiceCommandPort(programArguments: string[] = []): string {
  let latest: string | undefined;
  for (let index = 0; index < programArguments.length; index += 1) {
    const arg = programArguments[index];
    if (arg === "--port") {
      latest = programArguments[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--port=")) {
      latest = arg.slice("--port=".length);
    }
  }
  return latest?.trim() ?? "";
}

function auditGatewayServicePort(params: {
  programArguments: string[] | undefined;
  issues: ServiceConfigIssue[];
  expectedPort?: number;
}) {
  if (
    typeof params.expectedPort !== "number" ||
    !Number.isSafeInteger(params.expectedPort) ||
    params.expectedPort <= 0 ||
    params.expectedPort > 65535
  ) {
    return;
  }
  const rawPort = readGatewayServiceCommandPort(params.programArguments);
  if (!rawPort) {
    return;
  }
  const servicePort = parseTcpPort(rawPort);
  if (servicePort === params.expectedPort) {
    return;
  }
  params.issues.push({
    code: SERVICE_AUDIT_CODES.gatewayPortMismatch,
    message: "Gateway service port does not match current gateway config.",
    detail: `${servicePort ?? rawPort} -> ${params.expectedPort}`,
    level: "recommended",
  });
}

function auditGatewayToken(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  expectedGatewayToken?: string,
) {
  const serviceToken = readEmbeddedGatewayToken(command);
  if (!serviceToken) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayTokenEmbedded,
    message: "Gateway service embeds OPENCLAW_GATEWAY_TOKEN and should be reinstalled.",
    level: "recommended",
  });
  const expectedToken = normalizeOptionalString(expectedGatewayToken);
  if (!expectedToken || serviceToken === expectedToken) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
    message:
      "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token in openclaw.json",
    detail: "service token is stale",
    level: "recommended",
  });
}

function auditGatewayPassword(command: GatewayServiceCommand, issues: ServiceConfigIssue[]) {
  if (
    !command?.environment?.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    isEnvironmentFileOnlySource(command.environmentValueSources?.OPENCLAW_GATEWAY_PASSWORD)
  ) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayPasswordEmbedded,
    message: "Gateway service embeds OPENCLAW_GATEWAY_PASSWORD and should be reinstalled.",
    detail: "Rotate the password after reinstalling because the service definition exposed it.",
    level: "recommended",
  });
}

function auditManagedServiceEnvironment(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  expectedManagedServiceEnvKeys?: Iterable<string>,
) {
  const inlineKeys = collectInlineManagedServiceEnvKeys(command, expectedManagedServiceEnvKeys);
  if (inlineKeys.length === 0) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded,
    message: "Gateway service embeds managed environment values that should load at runtime.",
    detail: `inline keys: ${inlineKeys.join(", ")}`,
    environmentKeys: inlineKeys,
    level: "recommended",
  });
}

function auditProxyServiceEnvironment(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
) {
  const inlineKeys = collectInlineServiceEnvKeys(command, SERVICE_PROXY_ENV_KEYS);
  if (inlineKeys.length === 0) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    message: "Gateway service embeds proxy environment values that should not be persisted.",
    detail: `inline keys: ${inlineKeys.join(", ")}`,
    environmentKeys: Object.entries(command?.environment ?? {})
      .filter(
        ([key, value]) =>
          value.trim() &&
          SERVICE_PROXY_ENV_KEYS.some((proxyKey) => proxyKey === key) &&
          hasInlineEnvironmentSource(
            readEnvironmentValueSource(command?.environmentValueSources, key),
          ),
      )
      .map(([key]) => key)
      .toSorted(),
    level: "recommended",
  });
}

export function readEmbeddedGatewayToken(command: GatewayServiceCommand): string | undefined {
  if (!command) {
    return undefined;
  }
  if (isEnvironmentFileOnlySource(command.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN)) {
    return undefined;
  }
  return normalizeOptionalString(command.environment?.OPENCLAW_GATEWAY_TOKEN);
}

function getEquivalentMinimalPathEntries(
  entry: string,
  platform: NodeJS.Platform,
  normalizedExpected: Set<string>,
): string[] {
  if (platform !== "linux") {
    return [];
  }
  const equivalent = entry.endsWith("/aliases/default/bin")
    ? `${entry.slice(0, -"/aliases/default/bin".length)}/current/bin`
    : entry.endsWith("/current/bin")
      ? `${entry.slice(0, -"/current/bin".length)}/aliases/default/bin`
      : undefined;
  if (!equivalent) {
    return [];
  }
  const normalizedEquivalent = normalizeServicePathEntry(equivalent, platform);
  return normalizedExpected.has(normalizedEquivalent) ? [equivalent] : [];
}

function auditGatewayServicePath(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  expectedServicePath?: string,
) {
  if (!command) {
    return;
  }
  if (platform === "win32") {
    return;
  }
  const servicePath = command?.environment?.PATH;
  if (!servicePath) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissing,
      message: "Gateway service PATH is not set; the daemon should use a minimal PATH.",
      level: "recommended",
    });
    return;
  }

  const expected = expectedServicePath?.trim()
    ? normalizeStringEntries(expectedServicePath.split(path.posix.delimiter))
    : getMinimalServicePathPartsFromEnv({
        platform,
        env,
        includeMissingUserBinDefaults: false,
      });
  const parts = normalizeStringEntries(servicePath.split(path.posix.delimiter));
  const normalizedParts = new Set(parts.map((entry) => normalizeServicePathEntry(entry, platform)));
  const normalizedExpected = new Set(
    expected.map((entry) => normalizeServicePathEntry(entry, platform)),
  );
  const missing = expected.filter((entry) => {
    const normalized = normalizeServicePathEntry(entry, platform);
    if (normalizedParts.has(normalized)) {
      return false;
    }
    return !getEquivalentMinimalPathEntries(entry, platform, normalizedExpected).some(
      (equivalent) => normalizedParts.has(normalizeServicePathEntry(equivalent, platform)),
    );
  });
  if (missing.length > 0) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
      message: `Gateway service PATH missing required dirs: ${missing.join(", ")}`,
      level: "recommended",
    });
  }

  const nonMinimal = parts.filter((entry) => {
    const normalized = normalizeServicePathEntry(entry, platform);
    if (normalizedExpected.has(normalized)) {
      return false;
    }
    return isNonMinimalServicePathEntry(normalized, platform);
  });
  if (nonMinimal.length > 0) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
      message:
        "Gateway service PATH includes version managers or package managers; recommend a minimal PATH.",
      detail: nonMinimal.join(", "),
      level: "recommended",
    });
  }
}

/**
 * Check if the service's embedded token differs from the config file token.
 * Returns an issue if drift is detected (service will use old token after restart).
 * The invoking CLI selects recovery advice for its installation.
 */
export function checkTokenDrift(params: {
  serviceToken: string | undefined;
  configToken: string | undefined;
}): ServiceConfigIssue | null {
  const serviceToken = normalizeOptionalString(params.serviceToken);
  const configToken = normalizeOptionalString(params.configToken);

  // Tokenless service units are canonical; no drift to report.
  if (!serviceToken) {
    return null;
  }

  if (configToken && serviceToken !== configToken) {
    return {
      code: SERVICE_AUDIT_CODES.gatewayTokenDrift,
      message:
        "Config token differs from service token. The daemon will use the old token after restart.",
      level: "recommended",
    };
  }

  return null;
}

/**
 * Check if the service's recorded managed environment variables differ from
 * the current durable environment (e.g. from state-dir .env).
 * Returns an issue if drift is detected (service will retain old environment after restart).
 */
export function checkManagedServiceEnvDrift(params: {
  serviceEnvironment: Record<string, string | undefined> | undefined;
  durableEnvironment: Record<string, string | undefined> | undefined;
  platform?: NodeJS.Platform;
}): ServiceConfigIssue | null {
  if (!params.serviceEnvironment || !params.durableEnvironment) {
    return null;
  }
  const platform = params.platform ?? process.platform;
  // systemd dynamically overrides managed keys at runtime via pre-bootstrap loader,
  // so static service-env drift does not cause the running daemon to retain stale values.
  if (
    platform === "linux" &&
    detectRespawnSupervisor(params.serviceEnvironment, "linux") === "systemd"
  ) {
    return null;
  }
  const managedKeys = readManagedServiceEnvKeysFromEnvironment(params.serviceEnvironment);
  if (managedKeys.size === 0) {
    return null;
  }
  const driftedKeys: string[] = [];
  for (const rawManagedKey of managedKeys) {
    const normalizedManaged = normalizeServiceEnvKey(rawManagedKey);
    if (
      !normalizedManaged ||
      normalizedManaged === "OPENCLAW_GATEWAY_TOKEN" ||
      normalizedManaged === "OPENCLAW_SERVICE_VERSION"
    ) {
      continue;
    }
    let serviceValue: string | undefined;
    for (const [key, value] of Object.entries(params.serviceEnvironment)) {
      if (normalizeServiceEnvKey(key) === normalizedManaged) {
        serviceValue = value;
        break;
      }
    }
    let durableValue: string | undefined;
    for (const [key, value] of Object.entries(params.durableEnvironment)) {
      if (normalizeServiceEnvKey(key) === normalizedManaged) {
        durableValue = value;
        break;
      }
    }
    const serviceTrimmed = serviceValue?.trim() ?? "";
    const durableTrimmed = durableValue?.trim() ?? "";
    if (serviceTrimmed !== durableTrimmed) {
      driftedKeys.push(rawManagedKey);
    }
  }
  if (driftedKeys.length === 0) {
    return null;
  }
  driftedKeys.sort();
  return {
    code: SERVICE_AUDIT_CODES.gatewayEnvDrift,
    message: `State-dir .env differs from service environment for managed keys (${driftedKeys.join(", ")}). The daemon will use the old environment after restart.`,
    detail: `drifted keys: ${driftedKeys.join(", ")}`,
    environmentKeys: driftedKeys,
    level: "recommended",
  };
}

export async function auditGatewayServiceConfig(params: {
  env: Record<string, string | undefined>;
  command: GatewayServiceCommand;
  expectedCommand?: GatewayServiceExpectedCommand;
  platform?: NodeJS.Platform;
  expectedGatewayToken?: string;
  expectedManagedServiceEnvKeys?: Iterable<string>;
  expectedServicePath?: string;
  expectedPort?: number;
  expectedDurableEnvironment?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<ServiceConfigAudit> {
  const issues: ServiceConfigIssue[] = [];
  const definitionDrift: ServiceDefinitionDrift[] = [];
  let definitionDriftError: string | undefined;
  const platform = params.platform ?? process.platform;
  if (params.expectedCommand) {
    auditGatewayInstallPreservation(
      params.command,
      params.expectedCommand,
      platform,
      definitionDrift,
    );
  }

  auditGatewayCommand(params.command?.programArguments, issues);
  auditGatewayServicePort({
    programArguments: params.command?.programArguments,
    issues,
    expectedPort: params.expectedPort,
  });
  auditManagedServiceEnvironment(params.command, issues, params.expectedManagedServiceEnvKeys);
  auditProxyServiceEnvironment(params.command, issues);
  auditGatewayToken(params.command, issues, params.expectedGatewayToken);
  auditGatewayPassword(params.command, issues);
  auditGatewayServicePath(params.command, issues, params.env, platform, params.expectedServicePath);
  const envDrift = checkManagedServiceEnvDrift({
    serviceEnvironment: params.command?.environment,
    durableEnvironment: params.expectedDurableEnvironment,
    platform,
  });
  if (envDrift) {
    issues.push(envDrift);
  }
  const runtimeNote = await auditGatewayRuntime(
    params.env,
    params.command,
    issues,
    platform,
    params.timeoutMs,
  );

  if (platform === "linux") {
    definitionDriftError = await auditSystemdUnit(
      params.env,
      issues,
      params.timeoutMs,
      params.command,
      definitionDrift,
      Boolean(params.expectedCommand),
    );
  }

  try {
    if (platform === "darwin") {
      await auditLaunchdDefinition(
        params.env,
        issues,
        definitionDrift,
        params.timeoutMs,
        Boolean(params.expectedCommand),
      );
    } else if (platform === "win32" && params.command) {
      await auditScheduledTaskDefinition(
        params.env,
        definitionDrift,
        params.timeoutMs,
        params.expectedCommand,
      );
    }
  } catch {
    definitionDriftError = "Service definition inspection could not be completed.";
  }

  const notes = {
    ...(runtimeNote ? { runtimeNote } : {}),
    ...(definitionDrift.length ? { definitionDrift } : {}),
    ...(definitionDriftError ? { definitionDriftError } : {}),
  };
  return { ok: issues.length === 0, issues, ...notes };
}
