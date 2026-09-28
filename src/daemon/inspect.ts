/** Inspects installed platform services for extra OpenClaw or legacy gateway jobs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { hasErrnoCode } from "../infra/errno.js";
import { findExistingAncestor } from "../infra/fs-safe.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  normalizeWindowsTaskIdentity,
  resolveGatewayLaunchAgentLabel,
} from "./constants.js";
import {
  collectServiceFiles,
  isLegacyLabel,
  isPotentialGatewayServiceName,
  readServiceFile,
  scanSystemdDir,
  type ExtraGatewayService,
  type ServiceFileInspectionError,
} from "./inspect-files.js";
import {
  hasGatewaySubcommandArg,
  hasGatewayServiceMarker,
  detectLaunchdGatewayExecutionMarker,
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
import { listLoadedSystemdUnits } from "./systemd-loaded-unit-inventory.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import {
  DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS,
  resolveSystemdUnitLoadDirectories,
} from "./systemd-unit-load-paths.js";

export type { ExtraGatewayService } from "./inspect-files.js";

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

export type GatewayServiceInventory = {
  services: ExtraGatewayService[];
  errors: ServiceFileInspectionError[];
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

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  try {
    for (const dir of DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS) {
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
  requireComplete = false,
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
      const loadDirs = requireComplete
        ? resolveSystemdUnitLoadDirectories(env, home, process.geteuid?.())
        : undefined;
      if (loadDirs && !loadDirs.complete) {
        errors.push({
          source: "systemd",
          message: "Systemd unit load paths could not be verified.",
        });
      }
      const userServices: InspectedGatewayService[] = [];
      for (const dir of loadDirs?.userDirs ?? [userDir]) {
        userServices.push(
          ...(await scanSystemdDir({
            dir,
            scope: "user",
            selectedName: resolveSystemdServiceName(env),
            errors,
          })),
        );
      }
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
        for (const dir of loadDirs?.systemDirs ?? DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS) {
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
      if (requireComplete) {
        for (const scope of ["user", "system"] as const) {
          try {
            for (const unit of await listLoadedSystemdUnits(scope, env)) {
              const name = unit.name.slice(0, -".service".length);
              const command = normalizeLowercaseStringOrEmpty(unit.execStart);
              const gatewayArg = /(?:^|[\s;])gateway(?:[\s;]|$)/.test(command);
              const marker = gatewayArg
                ? (EXTRA_MARKERS.find((value) => command.includes(value)) ?? null)
                : null;
              const selected = isPotentialGatewayServiceName(
                name,
                "linux",
                resolveSystemdServiceName(env),
              );
              if (!marker && !selected) {
                continue;
              }
              if (!path.posix.isAbsolute(unit.fragmentPath)) {
                errors.push({
                  source: unit.name,
                  message: "Loaded systemd Gateway definition could not be inspected.",
                });
                continue;
              }
              push({
                platform: "linux",
                label: unit.name,
                detail: `unit: ${unit.fragmentPath}`,
                scope,
                marker: marker ?? "openclaw",
                legacy: marker === "clawdbot",
                extra: true,
                managedGateway: marker !== "clawdbot",
              });
            }
          } catch {
            errors.push({
              source: scope === "user" ? "systemctl --user" : "systemctl --system",
              message: "Loaded systemd services could not be inspected.",
            });
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
        if (requireComplete) {
          errors.push({
            source: "schtasks",
            message: "Scheduled Task identity could not be inspected.",
          });
        }
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
      const knownTask = selected || isOpenClawGatewayTaskName(name) || isLegacyLabel(name);
      // A stopped unrelated task cannot hold the checkout's live dist. Keep unknown,
      // queued, and running tasks fail-closed when their command cannot be read.
      const mayHoldLiveGateway = task.state !== 1 && task.state !== 3;
      const launcherReference = actionArgv.some((argv) =>
        argv.some((arg) => /\.(?:bat|cmd|vbs)$/i.test(arg) && detectLauncherGatewayMarker(arg)),
      );
      if (!task.actions?.length) {
        if ((requireComplete && mayHoldLiveGateway) || knownTask) {
          errors.push({ source: name, message: "Scheduled Task action could not be inspected." });
        }
        continue;
      }
      const actionMarkers = actionArgv.map((argv, index) =>
        detectWindowsServiceExecutionMarker(argv, task.actions?.[index]?.workingDirectory),
      );
      const hasGatewayAction = actionArgv.some(
        (argv, index) => actionMarkers[index] === "openclaw" && hasGatewaySubcommandArg(argv),
      );
      const hasLauncherAction = actionArgv.some((argv) =>
        argv.some((arg) => /\.(?:bat|cmd|vbs)$/i.test(arg)),
      );
      if (
        requireComplete &&
        task.actions.length > 1 &&
        (hasGatewayAction || (hasLauncherAction && (mayHoldLiveGateway || knownTask)))
      ) {
        errors.push({
          source: name,
          message: "Multiple Scheduled Task actions could not be inspected as one Gateway.",
        });
        continue;
      }
      let marker = hasGatewayAction ? "openclaw" : (actionMarkers.find(Boolean) ?? null);
      let gateway = actionArgv.some(
        (argv, index) => actionMarkers[index] === "openclaw" && hasGatewaySubcommandArg(argv),
      );
      let profile =
        actionArgv.length === 1
          ? resolveWindowsServiceCommandProfile({ programArguments: actionArgv[0]! })
          : undefined;
      let recognizableLauncher = launcherReference;
      if (launcherReference || hasLauncherAction) {
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
          if (requireComplete && mayHoldLiveGateway && !command) {
            throw new Error("Registered launcher disappeared during inspection.");
          }
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
          if ((requireComplete && mayHoldLiveGateway) || knownTask || recognizableLauncher) {
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
      if (requireComplete && marker === "openclaw" && gateway && profile?.kind !== "resolved") {
        errors.push({ source: name, message: "Scheduled Task profile could not be inspected." });
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
  options: { requireComplete?: boolean } = {},
): Promise<{ services: ManagedGatewayService[]; errors: GatewayServiceInventory["errors"] }> {
  const inventory = await scanGatewayServices(env, { deep: true }, options.requireComplete);
  return {
    services: inventory.services
      .filter((service) => service.managedGateway)
      .map(({ extra: _extra, managedGateway: _managed, ...service }) => service),
    errors: inventory.errors,
  };
}
