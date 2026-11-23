import fs from "node:fs/promises";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { ExtraGatewayService } from "./inspect-files.js";
import { isWindowsGatewayRecoveryExecutable } from "./inspect-markers.js";

export type WindowsRecoveryTaskInspection =
  | { status: "missing"; path: string; soleAction: boolean }
  | { status: "present" }
  | { status: "unreadable" }
  | { status: "none" };

/**
 * A present recovery executable still belongs to the Windows package.
 * Deletion advice is limited to a task whose only action is that missing executable.
 */
export async function classifyWindowsRecoveryTask(
  actions: readonly { path: string }[] | undefined,
): Promise<WindowsRecoveryTaskInspection> {
  const normalized = (actions ?? []).map((action) => action.path.trim().replace(/^"+|"+$/g, ""));
  const recoveryPaths = normalized.filter((executable) =>
    isWindowsGatewayRecoveryExecutable(executable),
  );
  if (recoveryPaths.length === 0) {
    return { status: "none" };
  }
  let missingPath: string | undefined;
  for (const recoveryPath of recoveryPaths) {
    try {
      await fs.access(recoveryPath);
      return { status: "present" };
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        missingPath ??= recoveryPath;
        continue;
      }
      return { status: "unreadable" };
    }
  }
  if (!missingPath) {
    return { status: "present" };
  }
  return {
    status: "missing",
    path: missingPath,
    soleAction: normalized.length === 1 && recoveryPaths.length === 1,
  };
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
