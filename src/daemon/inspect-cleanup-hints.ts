import fs from "node:fs/promises";
import path from "node:path";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { hasErrnoCode } from "../infra/errno.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import type { ExtraGatewayService } from "./inspect-files.js";
import { isWindowsGatewayRecoveryExecutable } from "./inspect-markers.js";

export type WindowsRecoveryTaskInspection =
  | { status: "missing"; path: string; soleAction: boolean }
  | { status: "present" }
  | { status: "unreadable" }
  | { status: "unresolved" }
  | { status: "deadline" }
  | { status: "none" };

const PACKAGE_QUALIFIED_RECOVERY_ALIAS =
  /^%LOCALAPPDATA%\\Microsoft\\WindowsApps\\(?<family>[^\\/%:*?"<>|\r\n]+)\\(?<alias>openclaw-gateway-recovery(?:-[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)?\.exe)$/i;

function isDriveOrHostAbsolute(executable: string): boolean {
  if (/[%\r\n"]/.test(executable) || executable.startsWith("\\\\") || executable.startsWith("//")) {
    return false;
  }
  return /^[a-z]:[\\/]/i.test(executable) || path.posix.isAbsolute(executable);
}

function recoveryProbePath(
  executable: string,
  env: Record<string, string | undefined>,
): { kind: "probe"; path: string } | { kind: "unresolved" } | { kind: "ignore" } {
  const command = executable.trim().replace(/^"+|"+$/g, "");
  if (!isWindowsGatewayRecoveryExecutable(command)) {
    return { kind: "ignore" };
  }
  const qualified = PACKAGE_QUALIFIED_RECOVERY_ALIAS.exec(command);
  if (qualified?.groups) {
    const family = qualified.groups.family;
    const local = env.LOCALAPPDATA?.trim();
    if (
      !family ||
      family === "." ||
      family === ".." ||
      family.includes("..") ||
      !local ||
      !/^[a-z]:[\\/]/i.test(local) ||
      /[%\r\n"]/.test(local)
    ) {
      return { kind: "unresolved" };
    }
    const root = path.win32.normalize(path.win32.join(local, "Microsoft", "WindowsApps"));
    const resolved = path.win32.normalize(
      path.win32.join(root, family, qualified.groups.alias ?? ""),
    );
    const prefix = root.endsWith("\\") ? root : `${root}\\`;
    if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { kind: "unresolved" };
    }
    return { kind: "probe", path: resolved };
  }
  if (!isDriveOrHostAbsolute(command)) {
    return { kind: "unresolved" };
  }
  return { kind: "probe", path: command };
}

/**
 * A present recovery executable still belongs to the Windows package.
 * Deletion advice is limited to a task whose only action is that missing executable.
 * Env-var, relative, and UNC paths are not probed and are not confirmed missing.
 */
export async function classifyWindowsRecoveryTask(
  actions: readonly { path: string }[] | undefined,
  options: { env?: Record<string, string | undefined>; deadline?: number } = {},
): Promise<WindowsRecoveryTaskInspection> {
  const normalized = (actions ?? []).map((action) => action.path.trim().replace(/^"+|"+$/g, ""));
  const recoveryPaths = normalized.filter((executable) =>
    isWindowsGatewayRecoveryExecutable(executable),
  );
  if (recoveryPaths.length === 0) {
    return { status: "none" };
  }
  const env = options.env ?? {};
  let missingPath: string | undefined;
  let unresolved = false;
  for (const recoveryPath of recoveryPaths) {
    const probe = recoveryProbePath(recoveryPath, env);
    if (probe.kind === "ignore") {
      continue;
    }
    if (probe.kind === "unresolved") {
      unresolved = true;
      continue;
    }
    if (options.deadline !== undefined && performance.now() >= options.deadline) {
      return { status: "deadline" };
    }
    try {
      const accessed = await awaitWithinDeadline(
        () => fs.access(probe.path),
        options.deadline,
        () => performance.now(),
      );
      if (accessed === ABSOLUTE_DEADLINE_EXPIRED) {
        return { status: "deadline" };
      }
      return { status: "present" };
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        missingPath ??= probe.path;
        continue;
      }
      return { status: "unreadable" };
    }
  }
  if (unresolved || !missingPath) {
    return unresolved ? { status: "unresolved" } : { status: "present" };
  }
  return {
    status: "missing",
    path: missingPath,
    soleAction: normalized.length === 1 && recoveryPaths.length === 1,
  };
}

export function isGatewayRemovalHint(hint: string): boolean {
  return /^\s*(?:sudo\s+)?(?:rm\b|schtasks\s+\/Delete\b|launchctl\s+bootout\b)/i.test(hint);
}

export function gatewayServiceCleanupHintLabel(hint: string): string {
  return isGatewayRemovalHint(hint) ? "Cleanup hint:" : "Inspection hint:";
}

export function formatGatewayServiceInspectionErrors(
  errors: readonly { source: string; message: string }[] | undefined,
): string[] {
  if (!errors?.length) {
    return [];
  }
  return [
    "Gateway service inspection failed:",
    ...errors.map((error) => `- ${error.source}: ${error.message}`),
  ];
}

export function renderGatewayServiceCleanupHints(
  services: readonly ExtraGatewayService[] = [],
): string[] {
  const hints: string[] = [];

  for (const service of services) {
    switch (service.platform) {
      case "darwin": {
        const plistPath = service.sourcePath;
        // Global LaunchAgents still run in a GUI domain; only LaunchDaemons
        // belong to the system domain regardless of their shared file scope.
        const domain =
          service.scope === "system" && plistPath?.startsWith("/Library/LaunchDaemons/")
            ? "system"
            : "gui/$UID";
        const launchctlCommand = domain === "system" ? "sudo launchctl" : "launchctl";
        hints.push(
          terminalText`${launchctlCommand} bootout ${domain}/${quoteCliArg(service.label)}`,
        );
        if (plistPath) {
          const removeCommand = service.scope === "system" ? "sudo rm" : "rm";
          hints.push(terminalText`${removeCommand} ${quoteCliArg(plistPath)}`);
        }
        break;
      }
      case "linux": {
        const systemctlCommand = `systemctl --${service.scope}`;
        const unit = quoteCliArg(service.label);
        // A discovered unit may be the only running Gateway; inspect before removal.
        hints.push(
          terminalText`${systemctlCommand} status -- ${unit}`,
          terminalText`${systemctlCommand} cat -- ${unit}`,
        );
        break;
      }
      case "win32":
        if (service.windowsStartupEntry) {
          hints.push(
            terminalText`Get-Item -LiteralPath '${service.windowsStartupEntry.replaceAll("'", "''")}'`,
          );
          break;
        }
        // Discovery includes Node hosts; inspect the task before choosing a removal owner.
        // The hint can be pasted into cmd.exe or PowerShell, so exclude names
        // that either shell can expand rather than guessing a common escape.
        if (/^[A-Za-z0-9_. ()\\/-]+$/.test(service.label)) {
          hints.push(terminalText`schtasks /Query /TN "${service.label}" /V /FO LIST`);
          // Only a task whose single action is the missing recovery executable
          // gets a delete command. Mixed actions stay inspection-only.
          if (service.windowsMissingRecoveryLauncher) {
            hints.push(terminalText`schtasks /Delete /F /TN "${service.label}"`);
          }
        }
        break;
    }
  }

  return hints;
}
