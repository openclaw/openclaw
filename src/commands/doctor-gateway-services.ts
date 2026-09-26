/** Doctor repairs for installed gateway service config and duplicate legacy services. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatGatewayServiceInstallationDrift } from "../cli/daemon-cli/shared.js";
import type { OpenClawConfig } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { isDefaultInstallIdentity, resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { formatGatewayHeapLimitReport, inspectGatewayHeapLimit } from "../daemon/gateway-heap.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
  type ExtraGatewayService,
} from "../daemon/inspect.js";
import { execLaunchctl, isLaunchctlNotLoaded } from "../daemon/launchd-exec.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import { readDaemonRuntimePin } from "../daemon/runtime-pin-state.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  readEmbeddedGatewayToken,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import {
  inspectGatewayServiceInstallationDrift,
  summarizeGatewayServiceLayout,
} from "../daemon/service-layout.js";
import { readManagedServiceEnvKeysFromEnvironment } from "../daemon/service-managed-env.js";
import {
  assertServiceDefinitionWritable,
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
} from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUnitActive, uninstallLegacySystemdUnits } from "../daemon/systemd.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON } from "../infra/gateway-supervision.js";
import { parseTcpPortFromArgs } from "../infra/tcp-port.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveGatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import {
  assertGatewayServiceInstallationRepairAllowed,
  canRepairRunningGatewayDefinition,
  installDoctorGatewayService,
  isExecStartRepairIssue,
  resolveSystemdScopeFromServicePath,
  resolveSystemdServiceRewriteBlock,
  resolveSystemdUnitNameFromServicePath,
  type DoctorGatewayInstallationMaintenance,
} from "./doctor-gateway-installation.js";
import { buildExpectedGatewayServicePlan } from "./doctor-gateway-runtime-plan.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import {
  formatServiceConfigIssues,
  hasRepairableServiceDefinitionDrift,
  isOperatorOwnedEnvironmentIssue,
  isServiceDefinitionOnlyRepair,
  isServiceInstallationOnlyRepair,
  reportServiceDefinitionDrift,
} from "./doctor-service-audit.js";
import {
  confirmDoctorServiceRepair,
  formatServiceRepairDeferredNote,
  isServiceRepairDeferred,
  resolveServiceRepairPolicy,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

export { maybeResolveDuelingSystemdGatewayScopes } from "./doctor-gateway-dueling.js";

type GatewayServiceConfigRepairOptions = {
  allowExecSecretRefs?: boolean;
  /** Resolves with the persisted candidate; refusal must reject before service mutation. */
  writeConfig: (nextConfig: OpenClawConfig) => Promise<OpenClawConfig>;
  serviceMaintenance?: DoctorGatewayInstallationMaintenance;
};

const DOCTOR_LAUNCHCTL_TIMEOUT_MS = 5_000;
const DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS = 100;
async function confirmLegacyLaunchdServiceUnloaded(serviceTarget: string): Promise<boolean> {
  const deadline = Date.now() + DOCTOR_LAUNCHCTL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await execLaunchctl(
      ["print", serviceTarget],
      Math.min(DOCTOR_LAUNCHCTL_TIMEOUT_MS, remainingMs),
    );
    if (probe.code !== 0) {
      // A successful print (including a stopped job) means launchd still owns
      // the label. Unknown errors and probe timeouts stay fail-closed.
      return isLaunchctlNotLoaded(probe);
    }
    const delayMs = Math.min(DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  return false;
}
const GATEWAY_SERVICES_EXTRA_CHECK_ID = "core/doctor/gateway-services/extra";

function extractDetailPath(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }
  const value = detail.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

async function filterInactiveExtraGatewayServices(
  services: ExtraGatewayService[],
): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return services;
  }
  const activeOrLegacy: ExtraGatewayService[] = [];
  for (const svc of services) {
    if (svc.platform !== "linux" || svc.legacy === true) {
      activeOrLegacy.push(svc);
      continue;
    }
    const active = await isSystemdUnitActive(process.env, svc.label, svc.scope);
    if (!active.ok || active.value) {
      activeOrLegacy.push(svc);
    }
  }
  return activeOrLegacy;
}

export async function detectExtraGatewayServiceIssues(
  options: Pick<DoctorOptions, "deep"> = {},
): Promise<readonly ExtraGatewayService[]> {
  if (!isDefaultInstallIdentity(process.env) || !(await shouldManageGatewayService())) {
    return [];
  }
  const detectedExtraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  return await filterInactiveExtraGatewayServices(detectedExtraServices);
}

export function extraGatewayServiceToHealthFinding(service: ExtraGatewayService): HealthFinding {
  return {
    checkId: GATEWAY_SERVICES_EXTRA_CHECK_ID,
    severity: service.legacy === true ? "warning" : "info",
    message: `Other gateway-like service detected: ${service.label} (${service.scope}, ${service.detail})`,
    source: service.platform,
    target: service.label,
    fixHint:
      service.legacy === true
        ? "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup."
        : "Run a single gateway per machine unless this extra gateway is intentional.",
  };
}

export function extraGatewayServiceToRepairEffects(
  service: ExtraGatewayService,
): readonly HealthRepairEffect[] {
  if (service.legacy !== true) {
    return [];
  }
  return [
    {
      kind: "service",
      action: "would-remove-legacy-gateway-service",
      target: service.label,
      dryRunSafe: false,
    },
  ];
}

async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<{ status: "removed"; destination?: string } | { status: "failed"; reason: string }> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execLaunchctl(["bootout", domain, params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);
  await execLaunchctl(["unload", params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);

  // bootout/unload can return before launchd finishes stopping the job. A plist
  // must stay in place unless a bounded print probe observes the label gone.
  if (!(await confirmLegacyLaunchdServiceUnloaded(`${domain}/${params.label}`))) {
    return { status: "failed", reason: "launchctl could not confirm unload" };
  }

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "removed" };
    }
    return { status: "failed", reason: "could not inspect plist" };
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return { status: "removed", destination: dest };
  } catch {
    return { status: "failed", reason: "could not move plist" };
  }
}

function classifyLegacyServices(legacyServices: ExtraGatewayService[]): {
  darwinUserServices: ExtraGatewayService[];
  linuxUserServices: ExtraGatewayService[];
  failed: string[];
} {
  const darwinUserServices: ExtraGatewayService[] = [];
  const linuxUserServices: ExtraGatewayService[] = [];
  const failed: string[] = [];

  for (const svc of legacyServices) {
    const userServices =
      svc.platform === "darwin"
        ? darwinUserServices
        : svc.platform === "linux"
          ? linuxUserServices
          : undefined;
    if (userServices && svc.scope === "user") {
      userServices.push(svc);
    } else {
      failed.push(`${svc.label} (${userServices ? svc.scope : svc.platform})`);
    }
  }

  return { darwinUserServices, linuxUserServices, failed };
}

async function cleanupLegacyDarwinServices(
  services: ExtraGatewayService[],
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const svc of services) {
    const plistPath = extractDetailPath(svc.detail, "plist:");
    if (!plistPath) {
      failed.push(`${svc.label} (missing plist path)`);
      continue;
    }
    const result = await cleanupLegacyLaunchdService({
      label: svc.label,
      plistPath,
    });
    if (result.status === "removed") {
      removed.push(result.destination ? `${svc.label} -> ${result.destination}` : svc.label);
    } else {
      failed.push(`${svc.label} (${result.reason})`);
    }
  }

  return { removed, failed };
}

async function cleanupLegacyLinuxUserServices(
  services: ExtraGatewayService[],
  runtime: RuntimeEnv,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  try {
    const removedUnits = await uninstallLegacySystemdUnits({
      env: process.env,
      stdout: process.stdout,
    });
    const removedByLabel: Map<string, (typeof removedUnits)[number]> = new Map(
      removedUnits.map((unit) => [`${unit.name}.service`, unit] as const),
    );
    for (const svc of services) {
      const removedUnit = removedByLabel.get(svc.label);
      if (!removedUnit) {
        failed.push(`${svc.label} (legacy unit name not recognized)`);
        continue;
      }
      removed.push(`${svc.label} -> ${removedUnit.unitPath}`);
    }
  } catch (err) {
    runtime.error(`Legacy Linux gateway cleanup failed: ${String(err)}`);
    for (const svc of services) {
      failed.push(`${svc.label} (linux cleanup failed)`);
    }
  }

  return { removed, failed };
}

/**
 * Audits and optionally rewrites the installed local gateway service configuration.
 *
 * The repair preserves managed env sources and avoids Nix/remote installs.
 * Updater-driven Doctor leaves service publication with update finalization.
 */
export async function maybeRepairGatewayServiceConfig(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: GatewayServiceConfigRepairOptions,
): Promise<OpenClawConfig> {
  if (!isDefaultInstallIdentity(process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return cfg;
  }
  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip service updates.", "Gateway");
    return cfg;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service audit.", "Gateway");
    return cfg;
  }

  const serviceRepairPolicy = resolveServiceRepairPolicy();
  const serviceRepairDeferred = isServiceRepairDeferred(serviceRepairPolicy);

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) {
    const audit = await auditGatewayServiceConfig({
      env: process.env,
      command: null,
      platform: process.platform,
    });
    reportServiceDefinitionDrift(audit);
    if (audit.issues.length > 0) {
      note(formatServiceConfigIssues(audit.issues).join("\n"), "Gateway service config");
    }
    return cfg;
  }
  const managedDefinition = resolveManagedGatewayServiceCommand(command) ?? command;
  note(
    formatGatewayHeapLimitReport(
      inspectGatewayHeapLimit(command.environment?.NODE_OPTIONS, {}, command.programArguments),
    ),
    "Gateway heap",
  );
  const managedWrapperPath = managedDefinition.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
  const pinSnapshot = readDaemonRuntimePin({ kind: "gateway", env: process.env }, command);
  const serviceInstallEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(managedWrapperPath && !Object.hasOwn(process.env, OPENCLAW_WRAPPER_ENV_KEY)
      ? { [OPENCLAW_WRAPPER_ENV_KEY]: managedWrapperPath }
      : {}),
  };
  const serviceWrapperPath = normalizeOptionalString(
    command.environment?.[OPENCLAW_WRAPPER_ENV_KEY],
  );
  if (serviceWrapperPath) {
    note(`Gateway service invokes ${OPENCLAW_WRAPPER_ENV_KEY}: ${serviceWrapperPath}`, "Gateway");
  }
  const serviceLayout = await summarizeGatewayServiceLayout(command);
  const sourceCheckoutWarning = serviceLayout?.entrypointSourceCheckout
    ? [
        `Gateway service entrypoint resolves to a source checkout: ${serviceLayout.packageRootReal ?? serviceLayout.packageRoot ?? serviceLayout.entrypointReal ?? serviceLayout.entrypoint}.`,
        "Run `openclaw gateway install --force` from the intended package install to replace the gateway service definition.",
      ].join("\n")
    : null;

  const tokenRefConfigured = Boolean(
    resolveSecretInputRef({
      value: cfg.gateway?.auth?.token,
      defaults: cfg.secrets?.defaults,
    }).ref,
  );
  const gatewayTokenResolution = await resolveGatewayAuthTokenForService(cfg, process.env, {
    allowExecSecretRefs: options.allowExecSecretRefs === true,
  });
  if (gatewayTokenResolution.unavailableReason) {
    note(
      `Unable to verify gateway service token drift: ${gatewayTokenResolution.unavailableReason}`,
      "Gateway service config",
    );
  }
  const expectedGatewayToken = tokenRefConfigured ? undefined : gatewayTokenResolution.token;
  const port = resolveGatewayPort(cfg, process.env);
  const hasInstallWrapper = Boolean(serviceInstallEnv[OPENCLAW_WRAPPER_ENV_KEY]?.trim());
  const activeRuntimePin = hasInstallWrapper ? undefined : pinSnapshot.pin?.path;
  const runtimeChoice = hasInstallWrapper
    ? "node"
    : resolveGatewayDaemonRuntime(
        activeRuntimePin ? [activeRuntimePin] : managedDefinition.programArguments,
      );
  const installedRuntimePath =
    runtimeChoice === "bun"
      ? (activeRuntimePin ?? managedDefinition.programArguments[0])
      : undefined;
  const expectedPlan = await buildExpectedGatewayServicePlan({
    cfg,
    command,
    serviceInstallEnv,
    port,
    runtime: runtimeChoice,
    runtimePath: installedRuntimePath,
    pinnedRuntimePath: pinSnapshot.pin?.path,
  });
  const expectedLayout = await summarizeGatewayServiceLayout(expectedPlan);
  const expectedRoot = expectedLayout?.packageRootReal;
  const installationDrift = expectedRoot
    ? await inspectGatewayServiceInstallationDrift(serviceLayout, expectedRoot)
    : undefined;
  const repairPort =
    installationDrift &&
    cfg.gateway?.port === undefined &&
    !process.env.OPENCLAW_GATEWAY_PORT?.trim()
      ? (parseTcpPortFromArgs(command.programArguments) ?? port)
      : port;
  const expectedManagedServiceEnvKeys = readManagedServiceEnvKeysFromEnvironment(
    expectedPlan.environment,
  );
  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
    expectedGatewayToken,
    expectedManagedServiceEnvKeys,
    expectedServicePath: expectedPlan.environment.PATH,
    expectedPort: repairPort,
    expectedDurableEnvironment: expectedPlan.environment,
    ...(installationDrift ? { expectedCommand: expectedPlan } : {}),
  });
  reportServiceDefinitionDrift(audit);
  const definitionRepair =
    !installationDrift &&
    Boolean(expectedRoot) &&
    !expectedLayout?.entrypointSourceCheckout &&
    hasRepairableServiceDefinitionDrift(audit);
  if (audit.runtimeNote) {
    note(audit.runtimeNote, "Gateway runtime");
  }
  const serviceToken = readEmbeddedGatewayToken(command);
  if (tokenRefConfigured && serviceToken) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
      message:
        "Gateway service OPENCLAW_GATEWAY_TOKEN should be unset when gateway.auth.token is SecretRef-managed",
      detail: "service token is stale",
      level: "recommended",
    });
  }
  const needsNodeRuntime =
    !hasInstallWrapper && !activeRuntimePin && needsNodeRuntimeMigration(audit.issues);
  // Unusable runtimes and version-managed Node services migrate through a concrete system Node.
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfo({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.status === "supported" ? systemNodeInfo.path : null;
  if (needsNodeRuntime && !systemNodePath && runtimeChoice !== "node") {
    const warning = renderSystemNodeWarning(systemNodeInfo);
    if (warning) {
      note(warning, "Gateway runtime");
    } else {
      note(
        `System Node ${SUPPORTED_NODE_VERSIONS} not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.`,
        "Gateway runtime",
      );
    }
  }

  const expectedRuntimePlan =
    needsNodeRuntime && systemNodePath
      ? await buildExpectedGatewayServicePlan({
          cfg,
          command,
          serviceInstallEnv,
          port: repairPort,
          runtime: "node",
          runtimePath: systemNodePath,
        })
      : expectedPlan;
  if (installationDrift && expectedRoot) {
    note(
      formatGatewayServiceInstallationDrift(installationDrift, undefined, serviceInstallEnv),
      "Gateway service installation",
    );
    if (!serviceRepairDeferred) {
      try {
        await assertGatewayServiceInstallationRepairAllowed({
          service,
          command,
          activeRoot: expectedRoot,
          maintenance: options.serviceMaintenance,
        });
      } catch (error) {
        note(String(error), "Gateway service installation");
        return cfg;
      }
    }
  }
  const runtimeLayout =
    expectedRuntimePlan === expectedPlan
      ? expectedLayout
      : await summarizeGatewayServiceLayout(expectedRuntimePlan);
  if (
    runtimeLayout?.entrypointReal &&
    serviceLayout?.entrypointReal &&
    runtimeLayout.entrypointReal !== serviceLayout.entrypointReal
  ) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "Gateway service entrypoint does not match the current install.",
      detail: `${serviceLayout?.entrypoint} -> ${runtimeLayout?.entrypoint}`,
      level: "recommended",
    });
  }

  const serviceRewriteBlock = installationDrift
    ? undefined
    : await resolveSystemdServiceRewriteBlock(command, audit.issues);
  if (serviceRewriteBlock) {
    note(serviceRewriteBlock, "Gateway service config");
  }

  const hasEntrypointMismatch = audit.issues.some(
    (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
  );
  const sourceCheckoutWarningToShow = hasEntrypointMismatch ? null : sourceCheckoutWarning;

  if (audit.issues.length === 0 && !definitionRepair) {
    if (sourceCheckoutWarningToShow !== null) {
      note(sourceCheckoutWarningToShow, "Gateway service config");
    }
    return cfg;
  }

  const consolidatedLines: string[] = [];
  if (sourceCheckoutWarningToShow !== null) {
    consolidatedLines.push(sourceCheckoutWarningToShow, "");
  }
  consolidatedLines.push(...formatServiceConfigIssues(audit.issues));
  note(consolidatedLines.join("\n"), "Gateway service config");
  if (
    audit.issues.length > 0 &&
    audit.issues.every((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeProbeFailed)
  ) {
    return cfg;
  }

  const needsAggressive =
    audit.issues.some((issue) => issue.level === "aggressive") ||
    (installationDrift !== undefined &&
      (audit.definitionDriftError !== undefined ||
        audit.definitionDrift?.some((finding) => finding.kind === "unknown-edit") === true));

  if (needsAggressive && !prompter.shouldForce) {
    note(
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  if (serviceRepairDeferred) {
    note(formatServiceRepairDeferredNote(), "Gateway service config");
    return cfg;
  }

  if (
    definitionRepair &&
    !options.serviceMaintenance &&
    !(await canRepairRunningGatewayDefinition({ service, command, env: serviceInstallEnv }))
  ) {
    return cfg;
  }

  if (serviceRewriteBlock) {
    return cfg;
  }

  if (
    process.platform === "linux" &&
    audit.issues.some(
      (issue) =>
        (isExecStartRepairIssue(issue) && hasGatewayServiceLauncherOverride(command)) ||
        (issue.code === SERVICE_AUDIT_CODES.gatewayPortMismatch &&
          hasGatewayServiceLauncherOverride(command, { includeWorkingDirectory: false })) ||
        isOperatorOwnedEnvironmentIssue(issue, command, expectedPlan.environmentValueSources),
    )
  ) {
    const unitName = resolveSystemdUnitNameFromServicePath(command.sourcePath);
    const scope = resolveSystemdScopeFromServicePath(command.sourcePath);
    const inspectCommand = `systemctl${scope === "user" ? " --user" : ""} cat ${unitName}`;
    note(
      `Gateway service command, working directory, or environment comes from an operator-owned systemd drop-in; rewriting the managed unit cannot repair it. Inspect with \`${inspectCommand}\`, then update or remove the drop-in and rerun doctor.`,
      "Gateway service config",
    );
    return cfg;
  }

  const gatewayTokenForRepair = expectedGatewayToken ?? readEmbeddedGatewayToken(managedDefinition);
  const configuredGatewayToken =
    typeof cfg.gateway?.auth?.token === "string"
      ? normalizeOptionalString(cfg.gateway.auth.token)
      : undefined;
  const needsConfigWrite =
    !tokenRefConfigured && !configuredGatewayToken && Boolean(gatewayTokenForRepair);
  const repair = await prompter.confirmRuntimeRepair({
    message: needsAggressive
      ? "Overwrite gateway service config with current defaults now?"
      : "Update gateway service config to the recommended defaults now?",
    initialValue: needsAggressive ? prompter.shouldForce : true,
    requiresInteractiveConfirmation:
      !(installationDrift && isServiceInstallationOnlyRepair(audit)) &&
      !(definitionRepair && !needsConfigWrite && isServiceDefinitionOnlyRepair(audit)),
  });
  if (!repair) {
    if (sourceCheckoutWarningToShow === null) {
      note(
        "Run `openclaw gateway install --force` when you want to replace the gateway service definition.",
        "Gateway service config",
      );
    }
    return cfg;
  }
  try {
    // Installed and planned environments can select different state files. Check
    // both before token persistence; native publication still revalidates under locks.
    for (const environment of [
      mergeGatewayServiceEnv(serviceInstallEnv, command),
      expectedRuntimePlan.environment,
    ]) {
      const capability = await service
        .readDefinitionMutationCapability?.({ env: serviceInstallEnv, environment })
        .catch(() => ({ kind: "unknown", reason: "inspection-failed" }) as const);
      if (capability) {
        assertServiceDefinitionWritable(capability);
      }
    }
  } catch (err) {
    runtime.error(`Gateway service repair blocked: ${String(err)}`);
    return cfg;
  }
  let cfgForServiceInstall = cfg;
  if (needsConfigWrite) {
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: cfg.gateway?.auth?.mode ?? "token",
          token: gatewayTokenForRepair,
        },
      },
    };
    try {
      cfgForServiceInstall = await options.writeConfig(nextCfg);
      note(
        expectedGatewayToken
          ? "Persisted gateway.auth.token from environment before reinstalling service."
          : "Persisted gateway.auth.token from existing service definition before reinstalling service.",
        "Gateway",
      );
    } catch (err) {
      if (err instanceof ConfigWritePostCommitError) {
        throw err;
      }
      runtime.error(`Failed to persist gateway.auth.token before service repair: ${String(err)}`);
      return cfg;
    }
  }

  const updatedPlan = await buildExpectedGatewayServicePlan({
    cfg: cfgForServiceInstall,
    command,
    serviceInstallEnv,
    port: repairPort,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    runtimePath: needsNodeRuntime && systemNodePath ? systemNodePath : installedRuntimePath,
    pinnedRuntimePath: pinSnapshot.pin?.path,
  });
  await installDoctorGatewayService({
    service,
    command,
    maintenance: options.serviceMaintenance,
    runtime,
    repair:
      installationDrift && expectedRoot
        ? { kind: "installation", root: expectedRoot }
        : definitionRepair && expectedRoot
          ? { kind: "definition", root: expectedRoot }
          : { kind: "config" },
    args: {
      ...updatedPlan,
      runtimePinUpdate: { expected: pinSnapshot, pin: pinSnapshot.pin },
      env: serviceInstallEnv,
      stdout: process.stdout,
      warn: (message) => note(message, "Gateway"),
    },
  });
  return cfgForServiceInstall;
}

/**
 * Reports duplicate gateway-like services and removes legacy user services after confirmation.
 */
export async function maybeScanExtraGatewayServices(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (!isDefaultInstallIdentity(process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return;
  }
  const extraServices = await detectExtraGatewayServiceIssues(options);
  if (extraServices.length === 0) {
    return;
  }

  note(
    extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"),
    "Other gateway-like services detected",
  );

  const legacyServices = extraServices.filter((svc) => svc.legacy === true);
  if (legacyServices.length > 0) {
    const serviceRepairPolicy = resolveServiceRepairPolicy();
    const serviceRepairDeferred = isServiceRepairDeferred(serviceRepairPolicy);
    if (serviceRepairDeferred) {
      note(formatServiceRepairDeferredNote(), "Legacy gateway cleanup skipped");
    }
    const shouldRemove = serviceRepairDeferred
      ? false
      : await confirmDoctorServiceRepair(
          prompter,
          {
            message: "Remove legacy gateway services now?",
            initialValue: true,
          },
          serviceRepairPolicy,
        );
    if (shouldRemove) {
      const removed: string[] = [];
      const { darwinUserServices, linuxUserServices, failed } =
        classifyLegacyServices(legacyServices);

      if (darwinUserServices.length > 0) {
        const result = await cleanupLegacyDarwinServices(darwinUserServices);
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (linuxUserServices.length > 0) {
        const result = await cleanupLegacyLinuxUserServices(linuxUserServices, runtime);
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (removed.length > 0) {
        note(removed.map((line) => `- ${line}`).join("\n"), "Legacy gateway removed");
      }
      if (failed.length > 0) {
        note(failed.map((line) => `- ${line}`).join("\n"), "Legacy gateway cleanup skipped");
      }
    }
  }

  // Legacy jobs have their own confirmed cleanup flow; generic hints must
  // only name detected extra services, never the active managed gateway.
  const cleanupHints = renderGatewayServiceCleanupHints(
    extraServices.filter((service) => service.legacy !== true),
  );
  if (cleanupHints.length > 0) {
    note(
      cleanupHints.map((hint) => `- ${hint}`).join("\n"),
      process.platform === "linux" ? "Inspection hints" : "Cleanup hints",
    );
  }

  note(
    [
      "Recommendation: run a single gateway per machine for most setups.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
