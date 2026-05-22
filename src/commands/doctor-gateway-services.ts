import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { replaceConfigFile, type OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
  type ExtraGatewayService,
} from "../daemon/inspect.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  readEmbeddedGatewayToken,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { readManagedServiceEnvKeysFromEnvironment } from "../daemon/service-managed-env.js";
import { resolveGatewayService, type GatewayServiceCommandConfig } from "../daemon/service.js";
import {
  isSystemdUnitActive,
  uninstallLegacySystemdUnits,
  type SystemdUnitScope,
} from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode } from "./doctor-repair-mode.js";
import {
  confirmDoctorServiceRepair,
  EXTERNAL_SERVICE_REPAIR_NOTE,
  isServiceRepairExternallyManaged,
  resolveServiceRepairPolicy,
} from "./doctor-service-repair-policy.js";

const execFileAsync = promisify(execFile);
const EXECSTART_REPAIR_CODES = new Set<string>([
  SERVICE_AUDIT_CODES.gatewayCommandMissing,
  SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
]);

export interface GatewayServiceConfigIssue {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly level: "recommended" | "aggressive";
}

export interface GatewayServicePlanWarning {
  readonly message: string;
  readonly title?: string;
}

export interface GatewayServiceConfigDetection {
  readonly status: "skipped" | "clean" | "issue";
  readonly reason?: string;
  readonly command?: GatewayServiceCommandConfig;
  readonly serviceInstallEnv?: NodeJS.ProcessEnv;
  readonly serviceWrapperPath?: string;
  readonly serviceRewriteBlocked?: boolean;
  readonly sourceCheckoutWarning?: string;
  readonly showSourceCheckoutWarning?: boolean;
  readonly tokenRefConfigured?: boolean;
  readonly expectedGatewayToken?: string;
  readonly runtimeChoice?: GatewayDaemonRuntime;
  readonly needsNodeRuntime?: boolean;
  readonly systemNodePath?: string | null;
  readonly gatewayRuntimeWarning?: string;
  readonly installPlanWarnings?: readonly GatewayServicePlanWarning[];
  readonly tokenWarning?: string;
  readonly issues: GatewayServiceConfigIssue[];
}

export interface ExtraGatewayServicesDetection {
  readonly services: readonly ExtraGatewayService[];
  readonly legacyServices: readonly ExtraGatewayService[];
  readonly cleanupHints: readonly string[];
}

export interface ExtraGatewayServicesRepairResult {
  readonly removed: readonly string[];
  readonly failed: readonly string[];
}

type GatewayServiceNoteSink = Partial<Pick<DoctorPrompter, "confirm">> & {
  note?: (message: string, title?: string) => void | Promise<void>;
};

type GatewayServicePrompter = DoctorPrompter & GatewayServiceNoteSink;

async function emitGatewayServiceNote(
  prompter: GatewayServiceNoteSink | undefined,
  message: string,
  title: string,
): Promise<void> {
  if (typeof prompter?.note === "function") {
    await prompter.note(message, title);
    return;
  }
  note(message, title);
}

function detectGatewayRuntime(programArguments: string[] | undefined): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = normalizeLowercaseStringOrEmpty(path.basename(first));
    if (base === "bun" || base === "bun.exe") {
      return "bun";
    }
    if (base === "node" || base === "node.exe") {
      return "node";
    }
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

function findGatewayEntrypoint(programArguments?: string[]): string | null {
  if (!programArguments || programArguments.length === 0) {
    return null;
  }
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return null;
  }
  return programArguments[gatewayIndex - 1] ?? null;
}

function buildGatewayServiceRepairEnv(
  command: GatewayServiceCommandConfig | null,
): NodeJS.ProcessEnv {
  const wrapperPath = command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
  if (!wrapperPath || Object.hasOwn(process.env, OPENCLAW_WRAPPER_ENV_KEY)) {
    return process.env;
  }
  return {
    ...process.env,
    [OPENCLAW_WRAPPER_ENV_KEY]: wrapperPath,
  };
}

function resolveGatewayServiceWrapperPath(
  command: GatewayServiceCommandConfig | null,
): string | null {
  return normalizeOptionalString(command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]) ?? null;
}

async function buildExpectedGatewayServicePlan(params: {
  cfg: OpenClawConfig;
  command: GatewayServiceCommandConfig;
  serviceInstallEnv: NodeJS.ProcessEnv;
  port: number;
  runtime: GatewayDaemonRuntime;
  nodePath?: string;
  warn?: (message: string, title?: string) => void;
}) {
  return buildGatewayInstallPlan({
    env: params.serviceInstallEnv,
    port: params.port,
    runtime: params.runtime,
    nodePath: params.nodePath,
    existingEnvironment: params.command.environment,
    existingEnvironmentValueSources: params.command.environmentValueSources,
    warn: params.warn ?? (() => {}),
    config: params.cfg,
  });
}

async function buildGatewayServiceAuditInputs(params: {
  cfg: OpenClawConfig;
  command: GatewayServiceCommandConfig;
  serviceInstallEnv: NodeJS.ProcessEnv;
  warn?: (message: string, title?: string) => void;
}) {
  const port = resolveGatewayPort(params.cfg, process.env);
  const runtimeChoice = detectGatewayRuntime(params.command.programArguments);
  const expectedPlan = await buildExpectedGatewayServicePlan({
    cfg: params.cfg,
    command: params.command,
    serviceInstallEnv: params.serviceInstallEnv,
    port,
    runtime: runtimeChoice,
    warn: params.warn,
  });
  const expectedManagedServiceEnvKeys = readManagedServiceEnvKeysFromEnvironment(
    expectedPlan.environment,
  );
  return { expectedManagedServiceEnvKeys, expectedPlan, port, runtimeChoice };
}

async function normalizeExecutablePath(value: string): Promise<string> {
  const resolvedPath = value.startsWith("/")
    ? path.posix.normalize(value)
    : path.isAbsolute(value)
      ? path.normalize(value)
      : path.resolve(value);
  try {
    return await fs.realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function extractDetailPath(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }
  const value = detail.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function isExecStartRepairIssue(issue: { code: string }): boolean {
  return EXECSTART_REPAIR_CODES.has(issue.code);
}

function resolveSystemdScopeFromServicePath(sourcePath: string | undefined): SystemdUnitScope {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  return normalized.startsWith("/etc/systemd/") ||
    normalized.startsWith("/usr/lib/systemd/") ||
    normalized.startsWith("/lib/systemd/")
    ? "system"
    : "user";
}

function resolveSystemdUnitNameFromServicePath(sourcePath: string | undefined): string {
  const base = sourcePath ? path.posix.basename(sourcePath.replaceAll("\\", "/")) : "";
  return base.endsWith(".service") ? base : "openclaw-gateway.service";
}

function shouldDeferUpdateModeSystemdServiceRepair(params: {
  repairMode: DoctorPrompter["repairMode"];
  shouldForce: boolean;
}): boolean {
  return (
    process.platform === "linux" &&
    isDoctorUpdateRepairMode(params.repairMode) &&
    !params.shouldForce
  );
}

async function suppressRunningSystemdExecStartRepairs(params: {
  command: GatewayServiceCommandConfig;
  issues: { code: string }[];
  emitNote?: boolean;
}): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  if (!params.issues.some(isExecStartRepairIssue)) {
    return false;
  }
  const unitName = resolveSystemdUnitNameFromServicePath(params.command.sourcePath);
  const scope = resolveSystemdScopeFromServicePath(params.command.sourcePath);
  if (!(await isSystemdUnitActive(process.env, unitName, scope))) {
    return false;
  }
  const before = params.issues.length;
  params.issues.splice(
    0,
    params.issues.length,
    ...params.issues.filter((issue) => !isExecStartRepairIssue(issue)),
  );
  if (params.issues.length !== before && params.emitNote !== false) {
    note(
      `Gateway service ${unitName} is running; skipped command/entrypoint rewrites for this doctor pass.`,
      "Gateway service config",
    );
  }
  return true;
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
    if (await isSystemdUnitActive(process.env, svc.label, svc.scope)) {
      activeOrLegacy.push(svc);
    }
  }
  return activeOrLegacy;
}

async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<string | null> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execFileAsync("launchctl", ["bootout", domain, params.plistPath]).catch(() => undefined);
  await execFileAsync("launchctl", ["unload", params.plistPath]).catch(() => undefined);

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch {
    return null;
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return dest;
  } catch {
    return null;
  }
}

export function classifyLegacyServices(legacyServices: readonly ExtraGatewayService[]): {
  darwinUserServices: ExtraGatewayService[];
  linuxUserServices: ExtraGatewayService[];
  failed: string[];
} {
  const darwinUserServices: ExtraGatewayService[] = [];
  const linuxUserServices: ExtraGatewayService[] = [];
  const failed: string[] = [];

  for (const svc of legacyServices) {
    if (svc.platform === "darwin") {
      if (svc.scope === "user") {
        darwinUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    if (svc.platform === "linux") {
      if (svc.scope === "user") {
        linuxUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    failed.push(`${svc.label} (${svc.platform})`);
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
    const dest = await cleanupLegacyLaunchdService({
      label: svc.label,
      plistPath,
    });
    removed.push(dest ? `${svc.label} -> ${dest}` : svc.label);
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

export async function detectExtraGatewayServices(
  options: Pick<DoctorOptions, "deep">,
): Promise<ExtraGatewayServicesDetection> {
  const detectedExtraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  const services = await filterInactiveExtraGatewayServices(detectedExtraServices);
  return {
    services,
    legacyServices: services.filter((svc) => svc.legacy === true),
    cleanupHints: renderGatewayServiceCleanupHints(),
  };
}

function formatExtraGatewayServiceLine(svc: ExtraGatewayService): string {
  return `${svc.label} (${svc.scope}, ${svc.detail})`;
}

export function formatExtraGatewayServiceFinding(svc: ExtraGatewayService): string {
  return `Gateway-like service detected: ${formatExtraGatewayServiceLine(svc)}.`;
}

export async function detectGatewayServiceConfigIssues(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
): Promise<GatewayServiceConfigDetection> {
  if (resolveIsNixMode(process.env)) {
    return { status: "skipped", reason: "Nix mode detected; skip service updates.", issues: [] };
  }

  if (mode === "remote") {
    return {
      status: "skipped",
      reason: "Gateway mode is remote; skipped local service audit.",
      issues: [],
    };
  }

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null = null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) {
    return { status: "clean", issues: [] };
  }
  const serviceInstallEnv = buildGatewayServiceRepairEnv(command);
  const serviceWrapperPath = resolveGatewayServiceWrapperPath(command);
  const installPlanWarnings: GatewayServicePlanWarning[] = [];
  const seenInstallPlanWarnings = new Set<string>();
  const collectInstallPlanWarning = (message: string, title?: string) => {
    const key = `${title ?? ""}\n${message}`;
    if (seenInstallPlanWarnings.has(key)) {
      return;
    }
    seenInstallPlanWarnings.add(key);
    installPlanWarnings.push({ message, ...(title ? { title } : {}) });
  };
  const serviceLayout = await summarizeGatewayServiceLayout(command);
  const sourceCheckoutWarning = serviceLayout?.entrypointSourceCheckout
    ? [
        `Gateway service entrypoint resolves to a source checkout: ${serviceLayout.packageRootReal ?? serviceLayout.packageRoot ?? serviceLayout.entrypointReal ?? serviceLayout.entrypoint}.`,
        "Run `openclaw doctor --fix` from the intended package install, or reinstall the gateway service with `openclaw gateway install --force`.",
      ].join("\n")
    : undefined;

  const tokenRefConfigured = Boolean(
    resolveSecretInputRef({
      value: cfg.gateway?.auth?.token,
      defaults: cfg.secrets?.defaults,
    }).ref,
  );
  const gatewayTokenResolution = await resolveGatewayAuthTokenForService(cfg, process.env);
  const tokenWarning = gatewayTokenResolution.unavailableReason
    ? `Unable to verify gateway service token drift: ${gatewayTokenResolution.unavailableReason}`
    : undefined;
  const expectedGatewayToken = tokenRefConfigured ? undefined : gatewayTokenResolution.token;
  const { expectedManagedServiceEnvKeys, expectedPlan, port, runtimeChoice } =
    await buildGatewayServiceAuditInputs({
      cfg,
      command,
      serviceInstallEnv,
      warn: collectInstallPlanWarning,
    });
  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
    expectedGatewayToken,
    expectedManagedServiceEnvKeys,
    expectedPort: port,
  });
  const issues = audit.issues as GatewayServiceConfigIssue[];
  const serviceToken = readEmbeddedGatewayToken(command);
  if (tokenRefConfigured && serviceToken) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
      message:
        "Gateway service OPENCLAW_GATEWAY_TOKEN should be unset when gateway.auth.token is SecretRef-managed",
      detail: "service token is stale",
      level: "recommended",
    });
  }
  const needsNodeRuntime = needsNodeRuntimeMigration(issues);
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfo({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
  const gatewayRuntimeWarning =
    needsNodeRuntime && !systemNodePath && runtimeChoice !== "node"
      ? (renderSystemNodeWarning(systemNodeInfo) ??
        "System Node 22 LTS (22.19+) or Node 24 not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.")
      : undefined;

  const expectedRuntimePlan =
    needsNodeRuntime && systemNodePath
      ? await buildExpectedGatewayServicePlan({
          cfg,
          command,
          serviceInstallEnv,
          port,
          runtime: "node",
          nodePath: systemNodePath,
          warn: collectInstallPlanWarning,
        })
      : expectedPlan;
  const { programArguments } = expectedRuntimePlan;
  const expectedEntrypoint = findGatewayEntrypoint(programArguments);
  const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
  const normalizedExpectedEntrypoint = expectedEntrypoint
    ? await normalizeExecutablePath(expectedEntrypoint)
    : null;
  const normalizedCurrentEntrypoint = currentEntrypoint
    ? await normalizeExecutablePath(currentEntrypoint)
    : null;
  if (
    normalizedExpectedEntrypoint &&
    normalizedCurrentEntrypoint &&
    normalizedExpectedEntrypoint !== normalizedCurrentEntrypoint
  ) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "Gateway service entrypoint does not match the current install.",
      detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
      level: "recommended",
    });
  }

  const serviceRewriteBlocked = await suppressRunningSystemdExecStartRepairs({
    command,
    issues,
    emitNote: false,
  });

  const hasEntrypointMismatch = issues.some(
    (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
  );
  const showSourceCheckoutWarning = sourceCheckoutWarning !== undefined && !hasEntrypointMismatch;

  return {
    status:
      issues.length > 0 ||
      serviceRewriteBlocked ||
      sourceCheckoutWarning ||
      installPlanWarnings.length > 0 ||
      tokenWarning ||
      gatewayRuntimeWarning
        ? "issue"
        : "clean",
    command,
    serviceInstallEnv,
    serviceWrapperPath: serviceWrapperPath ?? undefined,
    serviceRewriteBlocked,
    sourceCheckoutWarning,
    showSourceCheckoutWarning,
    tokenRefConfigured,
    expectedGatewayToken,
    runtimeChoice,
    needsNodeRuntime,
    systemNodePath,
    gatewayRuntimeWarning,
    installPlanWarnings,
    tokenWarning,
    issues,
  };
}

export type GatewayServiceConfigRepairResult = {
  status: "repaired" | "skipped" | "failed";
  reason?: string;
};

export async function repairGatewayServiceConfig(params: {
  cfg: OpenClawConfig;
  mode: "local" | "remote";
  runtime: RuntimeEnv;
  prompter: GatewayServicePrompter;
}): Promise<GatewayServiceConfigRepairResult> {
  const { cfg, mode, runtime, prompter } = params;
  const detection = await detectGatewayServiceConfigIssues(cfg, mode);
  if (detection.reason) {
    await emitGatewayServiceNote(prompter, detection.reason, "Gateway");
  }
  if (detection.serviceWrapperPath) {
    await emitGatewayServiceNote(
      prompter,
      `Gateway service invokes ${OPENCLAW_WRAPPER_ENV_KEY}: ${detection.serviceWrapperPath}`,
      "Gateway",
    );
  }
  if (detection.status === "skipped" || detection.status === "clean") {
    if (detection.sourceCheckoutWarning && detection.showSourceCheckoutWarning) {
      await emitGatewayServiceNote(
        prompter,
        detection.sourceCheckoutWarning,
        "Gateway service config",
      );
    }
    return {
      status: "skipped",
      reason:
        detection.status === "clean"
          ? "gateway service config is already current"
          : "gateway service config detection skipped",
    };
  }
  const {
    command,
    expectedGatewayToken,
    issues,
    needsNodeRuntime,
    runtimeChoice,
    serviceInstallEnv,
    serviceRewriteBlocked,
    showSourceCheckoutWarning,
    sourceCheckoutWarning,
    systemNodePath,
    tokenRefConfigured,
  } = detection;
  if (!command || !serviceInstallEnv || !runtimeChoice) {
    return {
      status: "skipped",
      reason: "gateway service config repair is missing service install context",
    };
  }
  if (detection.tokenWarning) {
    await emitGatewayServiceNote(prompter, detection.tokenWarning, "Gateway service config");
  }
  if (detection.gatewayRuntimeWarning) {
    await emitGatewayServiceNote(prompter, detection.gatewayRuntimeWarning, "Gateway runtime");
  }
  for (const warning of detection.installPlanWarnings ?? []) {
    await emitGatewayServiceNote(
      prompter,
      warning.message,
      warning.title ?? "Gateway service config",
    );
  }
  if (serviceRewriteBlocked) {
    await emitGatewayServiceNote(
      prompter,
      `Gateway service ${resolveSystemdUnitNameFromServicePath(command.sourcePath)} is running; skipped command/entrypoint rewrites for this doctor pass.`,
      "Gateway service config",
    );
  }

  if (issues.length === 0) {
    if (sourceCheckoutWarning !== undefined && showSourceCheckoutWarning) {
      await emitGatewayServiceNote(prompter, sourceCheckoutWarning, "Gateway service config");
    }
    return { status: "skipped", reason: "gateway service config has no repairable issues" };
  }

  const serviceRepairPolicy = resolveServiceRepairPolicy();
  const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);

  const consolidatedLines: string[] = [];
  let emittedSourceCheckoutWarning = false;
  if (sourceCheckoutWarning !== undefined && showSourceCheckoutWarning) {
    consolidatedLines.push(sourceCheckoutWarning);
    consolidatedLines.push("");
    emittedSourceCheckoutWarning = true;
  }
  consolidatedLines.push(
    ...issues.map((issue) =>
      issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
    ),
  );
  if (issues.length > 0) {
    await emitGatewayServiceNote(prompter, consolidatedLines.join("\n"), "Gateway service config");
  }

  const aggressiveIssues = issues.filter((issue) => issue.level === "aggressive");
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    await emitGatewayServiceNote(
      prompter,
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  if (serviceRepairExternal) {
    await emitGatewayServiceNote(prompter, EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway service config");
    return { status: "skipped", reason: "gateway service repair is externally managed" };
  }

  if (serviceRewriteBlocked) {
    await emitGatewayServiceNote(
      prompter,
      "Gateway service is running; leaving supervisor metadata unchanged. Stop the service first or use `openclaw gateway install --force` when you want to replace the active launcher.",
      "Gateway service config",
    );
    return {
      status: "skipped",
      reason: "gateway service rewrite is blocked while the service is running",
    };
  }

  const updateRepairMode = isDoctorUpdateRepairMode(prompter.repairMode);
  if (
    shouldDeferUpdateModeSystemdServiceRepair({
      repairMode: prompter.repairMode,
      shouldForce: prompter.shouldForce,
    })
  ) {
    await emitGatewayServiceNote(
      prompter,
      "Update-mode doctor detected gateway service drift but left the live systemd unit unchanged. Review the service file and run `openclaw gateway install --force` when you want OpenClaw to replace operator-owned systemd directives.",
      "Gateway service config",
    );
    return { status: "skipped", reason: "update-mode gateway service repair was deferred" };
  }

  const repairMessage = needsAggressive
    ? "Overwrite gateway service config with current defaults now?"
    : "Update gateway service config to the recommended defaults now?";
  const repair = updateRepairMode
    ? needsAggressive
      ? await prompter.confirmAggressiveAutoFix({
          message: repairMessage,
          initialValue: prompter.shouldForce,
        })
      : await prompter.confirmAutoFix({
          message: repairMessage,
          initialValue: true,
        })
    : await prompter.confirmRuntimeRepair({
        message: repairMessage,
        initialValue: needsAggressive ? prompter.shouldForce : true,
        requiresInteractiveConfirmation: true,
      });
  if (!repair) {
    if (!emittedSourceCheckoutWarning) {
      await emitGatewayServiceNote(
        prompter,
        "Run `openclaw gateway install --force` when you want to replace the gateway service definition.",
        "Gateway service config",
      );
    }
    return { status: "skipped", reason: "gateway service config repair was declined" };
  }
  const serviceEmbeddedToken = readEmbeddedGatewayToken(command);
  const gatewayTokenForRepair = expectedGatewayToken ?? serviceEmbeddedToken;
  const configuredGatewayToken =
    typeof cfg.gateway?.auth?.token === "string"
      ? normalizeOptionalString(cfg.gateway.auth.token)
      : undefined;
  let cfgForServiceInstall = cfg;
  if (
    !updateRepairMode &&
    !tokenRefConfigured &&
    !configuredGatewayToken &&
    gatewayTokenForRepair
  ) {
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
      await replaceConfigFile({
        nextConfig: nextCfg,
        afterWrite: { mode: "auto" },
      });
      cfgForServiceInstall = nextCfg;
      await emitGatewayServiceNote(
        prompter,
        expectedGatewayToken
          ? "Persisted gateway.auth.token from environment before reinstalling service."
          : "Persisted gateway.auth.token from existing service definition before reinstalling service.",
        "Gateway",
      );
    } catch (err) {
      runtime.error(`Failed to persist gateway.auth.token before service repair: ${String(err)}`);
      return { status: "failed", reason: "failed to persist gateway auth token" };
    }
  }

  const updatedPort = resolveGatewayPort(cfgForServiceInstall, process.env);
  const updatedPlan = await buildExpectedGatewayServicePlan({
    cfg: cfgForServiceInstall,
    command,
    serviceInstallEnv,
    port: updatedPort,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    nodePath: systemNodePath ?? undefined,
    warn: (message, title) => {
      void emitGatewayServiceNote(prompter, message, title ?? "Gateway service config");
    },
  });
  const service = resolveGatewayService();
  try {
    await (updateRepairMode ? service.stage : service.install)({
      env: serviceInstallEnv,
      stdout: process.stdout,
      programArguments: updatedPlan.programArguments,
      workingDirectory: updatedPlan.workingDirectory,
      environment: updatedPlan.environment,
      environmentValueSources: updatedPlan.environmentValueSources,
    });
  } catch (err) {
    runtime.error(`Gateway service update failed: ${String(err)}`);
    return { status: "failed", reason: "gateway service update failed" };
  }
  return { status: "repaired" };
}

export async function maybeRepairGatewayServiceConfig(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  await repairGatewayServiceConfig({ cfg, mode, runtime, prompter });
}

export async function repairExtraGatewayServices(params: {
  options: DoctorOptions;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
}): Promise<ExtraGatewayServicesRepairResult> {
  const removed: string[] = [];
  const failed: string[] = [];
  const { options, runtime, prompter } = params;
  const detection = await detectExtraGatewayServices(options);
  const extraServices = [...detection.services];
  if (extraServices.length === 0) {
    return { removed, failed };
  }

  await emitGatewayServiceNote(
    prompter,
    extraServices.map((svc) => `- ${formatExtraGatewayServiceLine(svc)}`).join("\n"),
    "Other gateway-like services detected",
  );

  const legacyServices = [...detection.legacyServices];
  if (legacyServices.length > 0) {
    const serviceRepairPolicy = resolveServiceRepairPolicy();
    const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
    if (serviceRepairExternal) {
      await emitGatewayServiceNote(
        prompter,
        EXTERNAL_SERVICE_REPAIR_NOTE,
        "Legacy gateway cleanup skipped",
      );
    }
    const shouldRemove = serviceRepairExternal
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
      const {
        darwinUserServices,
        linuxUserServices,
        failed: classifiedFailed,
      } = classifyLegacyServices(legacyServices);
      failed.push(...classifiedFailed);

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
        await emitGatewayServiceNote(
          prompter,
          removed.map((line) => `- ${line}`).join("\n"),
          "Legacy gateway removed",
        );
      }
      if (failed.length > 0) {
        await emitGatewayServiceNote(
          prompter,
          failed.map((line) => `- ${line}`).join("\n"),
          "Legacy gateway cleanup skipped",
        );
      }
      if (removed.length > 0) {
        runtime.log("Legacy gateway services removed. Installing OpenClaw gateway next.");
      }
    }
  }

  if (detection.cleanupHints.length > 0) {
    await emitGatewayServiceNote(
      prompter,
      detection.cleanupHints.map((hint) => `- ${hint}`).join("\n"),
      "Cleanup hints",
    );
  }

  await emitGatewayServiceNote(
    prompter,
    [
      "Recommendation: run a single gateway per machine for most setups.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
  return { removed, failed };
}

export async function maybeScanExtraGatewayServices(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  await repairExtraGatewayServices({ options, runtime, prompter });
}
