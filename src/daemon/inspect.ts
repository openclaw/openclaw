/** Inspects installed platform services for extra OpenClaw or legacy gateway jobs. */
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { getRootOptionAwareCommandPath } from "../infra/cli-root-options.js";
import { isEnvAssignmentToken, resolveCarrierCommandArgv } from "../infra/command-carriers.js";
import { hasErrnoCode } from "../infra/errno.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import { POSIX_SHELL_WRAPPERS } from "../infra/shell-wrapper-resolution.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseCmdSetAssignment } from "./cmd-set.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  normalizeWindowsTaskIdentity,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  resolveNodeLaunchAgentLabel,
} from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { decodeLaunchdPlistMetadata, resolveGeneratedEnvWrapperLayout } from "./launchd-plist.js";
import { resolveDaemonHomeDir } from "./paths.js";
import { resolveRuntimeScriptPosition } from "./runtime-binary.js";
import { readScheduledTaskCommand, resolveTaskName } from "./schtasks-layout.js";
import { listScheduledTasks } from "./schtasks-state-probe.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import {
  parseSystemdInlineEnvironment,
  parseSystemdExecStart,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

export type GatewayServiceInventory = {
  services: ExtraGatewayService[];
  errors: Array<{ source: string; message: string }>;
};

type InspectedGatewayService = ExtraGatewayService & {
  extra: boolean;
};

function projectService({
  extra: _extra,
  ...service
}: InspectedGatewayService): ExtraGatewayService {
  return service;
}

const EXTRA_MARKERS = ["openclaw", "clawdbot"] as const;

export function renderGatewayServiceCleanupHints(
  services: readonly ExtraGatewayService[] = [],
): string[] {
  const hints: string[] = [];

  for (const service of services) {
    switch (service.platform) {
      case "darwin": {
        const plistPath = service.detail.startsWith("plist:")
          ? service.detail.slice("plist:".length).trim()
          : undefined;
        // Global LaunchAgents still run in a GUI domain; only LaunchDaemons
        // belong to the system domain regardless of their shared file scope.
        const domain =
          service.scope === "system" && plistPath?.startsWith("/Library/LaunchDaemons/")
            ? "system"
            : "gui/$UID";
        const launchctlCommand = domain === "system" ? "sudo launchctl" : "launchctl";
        hints.push(`${launchctlCommand} bootout ${domain}/${quoteCliArg(service.label)}`);
        if (plistPath) {
          const removeCommand = service.scope === "system" ? "sudo rm" : "rm";
          hints.push(`${removeCommand} ${quoteCliArg(plistPath)}`);
        }
        break;
      }
      case "linux": {
        const systemctlCommand = `systemctl --${service.scope}`;
        const unit = quoteCliArg(service.label);
        // A discovered unit may be the only running Gateway; inspect before removal.
        hints.push(`${systemctlCommand} status -- ${unit}`, `${systemctlCommand} cat -- ${unit}`);
        break;
      }
      case "win32":
        // Discovery includes Node hosts; inspect the task before choosing a removal owner.
        // The hint can be pasted into cmd.exe or PowerShell, so exclude names
        // that either shell can expand rather than guessing a common escape.
        if (/^[A-Za-z0-9_. ()\\/-]+$/.test(service.label)) {
          hints.push(`schtasks /Query /TN "${service.label}" /V /FO LIST`);
        }
        break;
    }
  }

  return hints;
}

type Marker = (typeof EXTRA_MARKERS)[number];

function hasGatewaySubcommandArg(programArguments: string[]): boolean {
  let args =
    resolveCarrierCommandArgv(programArguments, 0, { includeExec: true }) ?? programArguments;
  if (POSIX_SHELL_WRAPPERS.has(path.posix.basename(args[0] ?? "").toLowerCase())) {
    const { command } = resolveInlineCommandMatch(args, POSIX_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
    });
    const inner = command ? splitShellArgs(command) : null;
    if (!inner) {
      return false;
    }
    while (inner.length > 0 && isEnvAssignmentToken(inner[0]!)) {
      inner.shift();
    }
    args = resolveCarrierCommandArgv(inner, 0, { includeExec: true }) ?? inner;
  }
  args = resolveCarrierCommandArgv(args, 0, { includeExec: true }) ?? args;
  const position = resolveRuntimeScriptPosition(args);
  if (typeof position !== "number" && position.kind !== "not-runtime") {
    return false;
  }
  const entryIndex = typeof position === "number" ? position : 0;
  return getRootOptionAwareCommandPath(["node", ...args.slice(entryIndex)], 1)[0] === "gateway";
}

export function detectMarkerLineWithGateway(contents: string): Marker | null {
  // Use the same physical-comment rules as service rewrites; comments must not
  // hide a runnable extra service from diagnostics.
  for (const line of splitSystemdLogicalLines(contents)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const assignment = trimmed.indexOf("=");
    if (assignment > 0) {
      const key = normalizeLowercaseStringOrEmpty(trimmed.slice(0, assignment));
      if (
        key !== "execstart" ||
        !hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim()))
      ) {
        continue;
      }
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (!normalized.includes("gateway")) {
      continue;
    }
    for (const marker of EXTRA_MARKERS) {
      if (normalized.includes(marker)) {
        return marker;
      }
    }
  }
  return null;
}

function hasGatewayServiceMarker(value: unknown): boolean {
  const environment = asOptionalRecord(value);
  return (
    environment?.OPENCLAW_SERVICE_MARKER === GATEWAY_SERVICE_MARKER &&
    environment.OPENCLAW_SERVICE_KIND === GATEWAY_SERVICE_KIND
  );
}

function hasSystemdGatewayServiceMarker(content: string): boolean {
  return hasGatewayServiceMarker(parseSystemdInlineEnvironment(content));
}

function detectLaunchdGatewayExecutionMarker(plist: Record<string, unknown>): Marker | null {
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    return null;
  }
  if (plist.Program !== undefined && typeof plist.Program !== "string") {
    return null;
  }
  const programArguments =
    typeof plist.Program === "string" ? [plist.Program, ...args.slice(1)] : args;
  const layout = resolveGeneratedEnvWrapperLayout(programArguments);
  const command = layout ? programArguments.slice(layout.commandStartIndex) : programArguments;
  if (!hasGatewaySubcommandArg(command)) {
    return null;
  }
  // Only execution command fields identify gateway jobs; labels alone catch too
  // many unrelated helper jobs.
  const launchCommand = normalizeLowercaseStringOrEmpty(command.join("\n"));
  return EXTRA_MARKERS.find((marker) => launchCommand.includes(marker)) ?? null;
}

function isOpenClawGatewaySystemdService(name: string, contents: string): boolean {
  if (hasSystemdGatewayServiceMarker(contents)) {
    return true;
  }
  if (!name.startsWith("openclaw-gateway")) {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(contents).includes("gateway");
}

function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  if (!normalized) {
    return false;
  }
  // Windows schtasks /Query returns task names prefixed with \ (e.g.
  // \OpenClaw Gateway for root-folder tasks). Strip the leading
  // backslash so the configured name matches correctly and the live
  // gateway task is not misidentified as an extra gateway service.
  const stripped = normalized.replace(/^\\+/, "");
  const defaultName = normalizeLowercaseStringOrEmpty(resolveGatewayWindowsTaskName());
  return stripped === defaultName || /^openclaw gateway \(.+\)$/.test(stripped);
}

function detectWindowsServiceExecutionMarker(args: string[], cwd?: string): Marker | null {
  if (
    classifyOpenClawArgv(args, { command: "gateway", cwd }).kind === "openclaw" ||
    classifyOpenClawArgv(args, { command: "node", cwd }).kind === "openclaw"
  ) {
    return "openclaw";
  }
  const command = normalizeLowercaseStringOrEmpty(args.join("\n"));
  if (command.includes("clawdbot")) {
    return "clawdbot";
  }
  return command.includes("openclaw") &&
    args.some((arg) => /^(?:gateway|node)$/.test(normalizeLowercaseStringOrEmpty(arg)))
    ? "openclaw"
    : null;
}

function detectLauncherGatewayMarker(contents: string): Marker | null {
  const environment: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const command = normalizeLowercaseStringOrEmpty(line.trim());
    if (command.startsWith("set ")) {
      const assignment = parseCmdSetAssignment(line.trimStart().slice(4), true);
      if (assignment) {
        environment[assignment.key] = assignment.value;
      }
      continue;
    }
    if (/^(?:#|;|'|rem\s)/.test(command) || !command.includes("gateway")) {
      continue;
    }
    const marker = EXTRA_MARKERS.find((candidate) => command.includes(candidate));
    if (marker) {
      return marker;
    }
  }
  return hasGatewayServiceMarker(environment) ? "openclaw" : null;
}

function isLegacyLabel(label: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(label);
  return lower.includes("clawdbot");
}

async function readServiceFile(filePath: string): Promise<Buffer | null> {
  return fs.readFile(filePath).catch(() => null);
}

function isPotentialGatewayServiceName(
  name: string,
  platform: "darwin" | "linux",
  selected?: string,
): boolean {
  return (
    name === selected ||
    (platform === "darwin"
      ? (name.startsWith("ai.openclaw.") && name !== resolveNodeLaunchAgentLabel()) ||
        /clawdbot.*gateway/.test(name)
      : /^(?:openclaw|clawdbot)(?:$|@|-gateway(?:$|[-.@]))/.test(name))
  );
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: Buffer;
};

async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isPotentialName: (name: string) => boolean;
  errors?: GatewayServiceInventory["errors"];
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(params.dir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      params.errors?.push({ source: params.dir, message: "Service path could not be inspected." });
    }
    return out;
  }
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    const fullPath = path.join(params.dir, entry);
    let contents: Buffer;
    try {
      contents = await fs.readFile(fullPath);
    } catch {
      if (params.isPotentialName(name)) {
        params.errors?.push({ source: fullPath, message: "Service path could not be inspected." });
      }
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
  managedLabel?: string;
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
}): Promise<InspectedGatewayService[]> {
  const results: InspectedGatewayService[] = [];
  const isPotentialName = (name: string) =>
    isPotentialGatewayServiceName(name, "darwin", params.selectedName);
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".plist",
    isPotentialName,
    errors: params.errors,
  });

  for (const { name: labelFromName, fullPath, contents } of candidates) {
    const plist = await decodeLaunchdPlistMetadata(contents).catch(() => {
      const contentHint = normalizeLowercaseStringOrEmpty(
        contents.toString("utf8").replaceAll("\0", ""),
      );
      if (
        isPotentialName(labelFromName) ||
        EXTRA_MARKERS.some((marker) => contentHint.includes(marker))
      ) {
        params.errors?.push({ source: fullPath, message: "Service plist could not be inspected." });
      }
      return undefined;
    });
    if (!plist) {
      continue;
    }
    const label = typeof plist.Label === "string" && plist.Label ? plist.Label : labelFromName;
    const executionMarker = detectLaunchdGatewayExecutionMarker(plist);
    const serviceMarker = hasGatewayServiceMarker(plist.EnvironmentVariables);
    const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
    const marker =
      label === params.managedLabel || serviceMarker
        ? "openclaw"
        : (executionMarker ?? (legacyLabel ? "clawdbot" : null));
    if (!marker) {
      continue;
    }
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw" || isLegacyLabel(label),
      extra:
        params.scope === "system" ||
        (label !== resolveGatewayLaunchAgentLabel() &&
          !(
            marker === "openclaw" &&
            (serviceMarker || (executionMarker === "openclaw" && label.startsWith("ai.openclaw.")))
          )),
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
}): Promise<InspectedGatewayService[]> {
  const results: InspectedGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    isPotentialName: (name) => isPotentialGatewayServiceName(name, "linux", params.selectedName),
    errors: params.errors,
  });

  for (const { entry, name, fullPath, contents: bytes } of candidates) {
    const contents = bytes.toString("utf8");
    const marker = hasSystemdGatewayServiceMarker(contents)
      ? "openclaw"
      : detectMarkerLineWithGateway(contents);
    if (!marker) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
      extra:
        name !== resolveGatewaySystemdServiceName() &&
        !(marker === "openclaw" && isOpenClawGatewaySystemdService(name, contents)),
    });
  }

  return results;
}

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  try {
    for (const dir of ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]) {
      results.push(
        ...(
          await scanSystemdDir({
            dir,
            scope: "system",
          })
        ).map(projectService),
      );
    }
  } catch {
    return [];
  }

  return results;
}

async function scanGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions,
): Promise<{ services: InspectedGatewayService[]; errors: GatewayServiceInventory["errors"] }> {
  const results: InspectedGatewayService[] = [];
  const errors: GatewayServiceInventory["errors"] = [];
  const inventory = { services: results, errors };
  const seen = new Set<string>();
  const push = (svc: InspectedGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(svc);
  };

  if (process.platform === "darwin") {
    try {
      const home = resolveDaemonHomeDir(env);
      const userDir = path.join(home, "Library", "LaunchAgents");
      for (const svc of await scanLaunchdDir({
        dir: userDir,
        scope: "user",
        selectedName: resolveLaunchAgentLabel(env),
        errors,
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchAgents"),
          scope: "system",
          selectedName: resolveLaunchAgentLabel(env),
          errors,
        })) {
          push(svc);
        }
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchDaemons"),
          scope: "system",
          managedLabel: resolveLaunchAgentLabel(env),
          selectedName: resolveLaunchAgentLabel(env),
          errors,
        })) {
          push(svc);
        }
      }
    } catch {
      errors.push({ source: "launchd", message: "Gateway service discovery could not finish." });
    }
    return inventory;
  }

  if (process.platform === "linux") {
    try {
      const home = resolveDaemonHomeDir(env);
      const userDir = path.join(home, ".config", "systemd", "user");
      const userServices = await scanSystemdDir({
        dir: userDir,
        scope: "user",
        selectedName: resolveSystemdServiceName(env),
        errors,
      });
      for (const svc of userServices) {
        push(svc);
      }
      for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
        const label = `${name}.service`;
        // The unit and its managed backup are one cleanup target. Report the
        // backup separately only when it is the remaining orphaned artifact.
        if (userServices.some((service) => service.label === label)) {
          continue;
        }
        const backupPath = path.join(userDir, `${name}.service.bak`);
        if ((await readServiceFile(backupPath)) !== null) {
          push({
            platform: "linux",
            label,
            detail: `unit backup: ${backupPath}`,
            scope: "user",
            marker: "clawdbot",
            legacy: true,
            extra: true,
          });
        }
      }
      if (opts.deep) {
        for (const dir of [
          "/etc/systemd/system",
          "/usr/lib/systemd/system",
          "/lib/systemd/system",
        ]) {
          for (const svc of await scanSystemdDir({
            dir,
            scope: "system",
            selectedName: resolveSystemdServiceName(env),
            errors,
          })) {
            push(svc);
          }
        }
      }
    } catch {
      errors.push({ source: "systemd", message: "Gateway service discovery could not finish." });
    }
    return inventory;
  }

  if (process.platform === "win32") {
    if (!opts.deep) {
      return inventory;
    }
    const deadline = performance.now() + WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS;
    const expired = () => deadline - performance.now() < 1;
    const recordDeadline = () =>
      errors.push({
        source: "schtasks",
        message: "Scheduled Task inventory deadline expired; some services could not be inspected.",
      });
    let tasks: ReturnType<typeof listScheduledTasks>;
    try {
      tasks = listScheduledTasks(deadline - performance.now());
    } catch {
      errors.push({ source: "schtasks", message: "Scheduled tasks could not be queried." });
      return inventory;
    }
    if (expired()) {
      recordDeadline();
      return inventory;
    }
    for (const task of tasks) {
      if (expired()) {
        recordDeadline();
        break;
      }
      const name = task.taskPath?.trim();
      if (!name) {
        continue;
      }
      const taskToRun =
        task.actions?.map((action) => `${action.path} ${action.arguments}`.trim()).join("; ") ?? "";
      const actionArgv =
        task.actions?.map((action) => [
          action.path,
          ...splitArgsPreservingQuotes(action.arguments, { escapeMode: "backslash-quote-only" }),
        ]) ?? [];
      const selected =
        normalizeWindowsTaskIdentity(name) === normalizeWindowsTaskIdentity(resolveTaskName(env));
      const launcherReference = actionArgv.some((argv) =>
        argv.some((arg) => /\.(?:cmd|vbs)$/i.test(arg) && detectLauncherGatewayMarker(arg)),
      );
      if (!task.actions?.length) {
        if (selected || isOpenClawGatewayTaskName(name) || isLegacyLabel(name)) {
          errors.push({ source: name, message: "Scheduled Task action could not be inspected." });
        }
        continue;
      }
      const actionMarkers = actionArgv.map((argv, index) =>
        detectWindowsServiceExecutionMarker(argv, task.actions?.[index]?.workingDirectory),
      );
      let marker = actionMarkers.find(Boolean) ?? null;
      let gateway = actionArgv.some(
        (argv, index) => actionMarkers[index] === "openclaw" && hasGatewaySubcommandArg(argv),
      );
      let recognizableLauncher = launcherReference;
      if (launcherReference || task.actions.some((action) => /\.(?:cmd|vbs)$/i.test(action.path))) {
        try {
          const command = await readScheduledTaskCommand(
            { ...env, OPENCLAW_WINDOWS_TASK_NAME: name, OPENCLAW_PROFILE: undefined },
            {
              requireEffective: true,
              requireLoaded: true,
              profileScope: "registered",
              deadline,
              onLauncherContent: (content) => {
                recognizableLauncher ||= Boolean(detectLauncherGatewayMarker(content));
              },
            },
          );
          const serviceMarker = command?.environment?.OPENCLAW_SERVICE_MARKER;
          const serviceKind = command?.environment?.OPENCLAW_SERVICE_KIND;
          marker = command
            ? detectWindowsServiceExecutionMarker(
                command.programArguments,
                command.workingDirectory,
              )
            : null;
          gateway = Boolean(command && hasGatewaySubcommandArg(command.programArguments));
          if (
            serviceMarker === "openclaw" &&
            (serviceKind === "gateway" || serviceKind === "node")
          ) {
            marker = "openclaw";
            gateway = serviceKind === "gateway";
          }
        } catch {
          if (expired()) {
            recordDeadline();
            break;
          }
          if (
            selected ||
            isOpenClawGatewayTaskName(name) ||
            isLegacyLabel(name) ||
            recognizableLauncher
          ) {
            errors.push({
              source: name,
              message: "Scheduled Task launcher could not be inspected.",
            });
          }
          continue;
        }
      }
      if (!marker) {
        continue;
      }
      push({
        platform: "win32",
        label: name,
        detail: taskToRun ? `task: ${name}, run: ${taskToRun}` : name,
        scope: "system",
        marker,
        legacy: marker !== "openclaw",
        extra: !(
          marker === "openclaw" &&
          gateway &&
          !isLegacyLabel(name) &&
          (selected || isOpenClawGatewayTaskName(name))
        ),
      });
    }
    return inventory;
  }

  return inventory;
}

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<GatewayServiceInventory> {
  const inventory = await scanGatewayServices(env, opts);
  return {
    services: inventory.services.filter((service) => service.extra).map(projectService),
    errors: inventory.errors,
  };
}
