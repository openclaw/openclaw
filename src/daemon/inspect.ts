/** Inspects installed platform services for extra OpenClaw or legacy gateway jobs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { findExistingAncestor } from "../infra/fs-safe.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  normalizeWindowsTaskIdentity,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import {
  collectServiceFiles,
  isLegacyLabel,
  isPotentialGatewayServiceName,
  readServiceFile,
} from "./inspect-files.js";
import {
  hasGatewaySubcommandArg,
  detectMarkerLineWithGateway,
  hasGatewayServiceMarker,
  hasSystemdGatewayServiceMarker,
  detectLaunchdGatewayExecutionMarker,
  isOpenClawGatewaySystemdService,
  isOpenClawGatewayTaskName,
  detectWindowsServiceExecutionMarker,
  detectLauncherGatewayMarker,
  EXTRA_MARKERS,
  type Marker,
} from "./inspect-markers.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import { resolveDaemonHomeDir } from "./paths.js";
import {
  readScheduledTaskCommand,
  readStartupEntryCommand,
  resolveStartupEntryPath,
  resolveStartupEntryPaths,
  resolveTaskName,
} from "./schtasks-layout.js";
import { listScheduledTasks } from "./schtasks-state-probe.js";
import { resolveWindowsServiceCommandProfile } from "./service-env-merge.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
  /** Exact Startup definition; a task label cannot identify this native owner. */
  windowsStartupEntry?: string;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

export type GatewayServiceInventory = {
  services: ExtraGatewayService[];
  errors: Array<{ source: string; message: string }>;
};

type ManagedGatewayService = ExtraGatewayService & {
  windowsProfile?: string;
};

type InspectedGatewayService = ManagedGatewayService & {
  extra: boolean;
  managedGateway: boolean;
};

function projectService({
  extra: _extra,
  managedGateway: _managed,
  windowsProfile: _windowsProfile,
  ...service
}: InspectedGatewayService): ExtraGatewayService {
  return service;
}

function quotePosixCleanupArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

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
        hints.push(
          `${launchctlCommand} bootout ${domain}/${quotePosixCleanupArgument(service.label)}`,
        );
        if (plistPath) {
          const removeCommand = service.scope === "system" ? "sudo rm" : "rm";
          hints.push(`${removeCommand} ${quotePosixCleanupArgument(plistPath)}`);
        }
        break;
      }
      case "linux": {
        const systemctlCommand = `systemctl --${service.scope}`;
        const unit = quotePosixCleanupArgument(service.label);
        // A discovered unit may be the only running Gateway; inspect before removal.
        hints.push(`${systemctlCommand} status -- ${unit}`, `${systemctlCommand} cat -- ${unit}`);
        break;
      }
      case "win32":
        if (service.windowsStartupEntry) {
          hints.push(
            `Get-Item -LiteralPath '${service.windowsStartupEntry.replaceAll("'", "''")}'`,
          );
          break;
        }
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
      managedGateway: marker === "openclaw" && (serviceMarker || executionMarker === "openclaw"),
      extra:
        params.scope === "system" ||
        (label !== resolveGatewayLaunchAgentLabel() &&
          !(
            marker === "openclaw" &&
            !legacyLabel &&
            params.scope === "user" &&
            label === params.selectedName
          ) &&
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
      managedGateway: marker === "openclaw",
      extra:
        name !== resolveGatewaySystemdServiceName() &&
        !(
          marker === "openclaw" &&
          !isLegacyLabel(name) &&
          params.scope === "user" &&
          name === params.selectedName
        ) &&
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

async function scanWindowsStartupEntries(
  env: Record<string, string | undefined>,
  errors: GatewayServiceInventory["errors"],
  deadline: number,
): Promise<InspectedGatewayService[]> {
  let directory: string;
  let selected: Set<string>;
  try {
    directory = path.dirname(resolveStartupEntryPath(env));
    selected = new Set(
      resolveStartupEntryPaths(env).map((entry) => path.win32.normalize(entry).toLowerCase()),
    );
  } catch {
    errors.push({ source: "startup", message: "Windows Startup folder could not be located." });
    return [];
  }
  let entries: string[];
  try {
    const found = await awaitWithinDeadline(
      async () => {
        try {
          return await fs.readdir(directory);
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT") || performance.now() >= deadline) {
            throw error;
          }
          // Windows also reports ENOENT when a path traverses a non-directory.
          const ancestor = await findExistingAncestor(directory);
          if (
            !ancestor ||
            ancestor === path.resolve(directory) ||
            performance.now() >= deadline ||
            !(await fs.stat(ancestor)).isDirectory()
          ) {
            throw error;
          }
          return [];
        }
      },
      deadline,
      () => performance.now(),
    );
    if (found === ABSOLUTE_DEADLINE_EXPIRED) {
      throw new Error("Startup inventory deadline expired.");
    }
    entries = found;
  } catch {
    errors.push({ source: directory, message: "Windows Startup folder could not be inspected." });
    return [];
  }
  const selectedStartupEntries = new Set<string>();
  if (
    entries.some((entry) =>
      selected.has(path.win32.normalize(path.join(directory, entry)).toLowerCase()),
    )
  ) {
    try {
      const command = await readScheduledTaskCommand(env, { requireLoaded: true, deadline });
      for (const entry of command?.startupEntryPaths ?? []) {
        selectedStartupEntries.add(path.win32.normalize(entry).toLowerCase());
      }
    } catch {
      errors.push({
        source: resolveTaskName(env),
        message: "Selected Gateway service could not be inspected.",
      });
    }
  }
  const services: InspectedGatewayService[] = [];
  for (const entry of entries.toSorted()) {
    if (performance.now() >= deadline) {
      errors.push({ source: directory, message: "Startup inventory deadline expired." });
      break;
    }
    if (!/\.(?:cmd|vbs)$/i.test(entry)) {
      continue;
    }
    const name = entry.slice(0, -4);
    const pathname = path.join(directory, entry);
    const pathIdentity = path.win32.normalize(pathname).toLowerCase();
    let gateway = /(?:openclaw|clawdbot).*gateway/i.test(name);
    let marker: Marker | undefined;
    try {
      const command = await readStartupEntryCommand(pathname, {
        deadline,
        onLauncherContent: (content) => {
          const hint = detectLauncherGatewayMarker(content);
          gateway ||= Boolean(hint);
          marker = hint ?? marker;
        },
      });
      const commandMarker = detectWindowsServiceExecutionMarker(
        command.programArguments,
        command.workingDirectory,
      );
      const serviceMarker = hasGatewayServiceMarker(command.environment);
      gateway = hasGatewaySubcommandArg(command.programArguments) || serviceMarker;
      marker = serviceMarker ? "openclaw" : (commandMarker ?? undefined);
      const profile = resolveWindowsServiceCommandProfile(command);
      const label = command.environment?.OPENCLAW_WINDOWS_TASK_NAME?.trim() || name;
      if (!marker || (!gateway && marker !== "clawdbot")) {
        continue;
      }
      services.push({
        platform: "win32",
        label,
        detail: `startup: ${pathname}`,
        scope: "user",
        marker,
        legacy: marker !== "openclaw",
        windowsStartupEntry: pathname,
        extra: marker !== "openclaw" || !selectedStartupEntries.has(pathIdentity),
        managedGateway: marker === "openclaw" && gateway,
        ...(profile.kind === "resolved" ? { windowsProfile: profile.profile } : {}),
      });
    } catch {
      const expired = performance.now() >= deadline;
      if (expired || gateway || selected.has(pathIdentity)) {
        errors.push({ source: pathname, message: "Startup launcher could not be inspected." });
      }
      if (expired) {
        break;
      }
    }
  }
  return services;
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
            managedGateway: false,
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
    const deadlineError = {
      source: "schtasks",
      message: "Scheduled Task inventory deadline expired; some services could not be inspected.",
    };
    const recordDeadline = () => {
      if (!errors.includes(deadlineError)) {
        errors.push(deadlineError);
      }
    };
    let tasks: ReturnType<typeof listScheduledTasks>;
    try {
      tasks = listScheduledTasks(deadline - performance.now());
    } catch {
      errors.push({ source: "schtasks", message: "Scheduled tasks could not be queried." });
      tasks = [];
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
      let profile =
        actionArgv.length === 1
          ? resolveWindowsServiceCommandProfile({ programArguments: actionArgv[0]! })
          : undefined;
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
          profile = command ? resolveWindowsServiceCommandProfile(command) : undefined;
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
        managedGateway: marker === "openclaw" && gateway,
        ...(profile?.kind === "resolved" ? { windowsProfile: profile.profile } : {}),
      });
    }
    if (expired()) {
      recordDeadline();
      return inventory;
    }
    for (const service of await scanWindowsStartupEntries(env, errors, deadline)) {
      push(service);
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

/** Complete managed selectors are discovery facts, not native lifecycle authority. */
export async function listManagedOpenClawGatewayServices(
  env: Record<string, string | undefined>,
): Promise<{ services: ManagedGatewayService[]; errors: GatewayServiceInventory["errors"] }> {
  const inventory = await scanGatewayServices(env, { deep: true });
  return {
    services: inventory.services
      .filter((service) => service.managedGateway)
      .map(({ extra: _extra, managedGateway: _managed, ...service }) => service),
    errors: inventory.errors,
  };
}
