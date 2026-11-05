import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  getBunCliLauncherPathIssue,
  inspectBunCliLauncher,
  installBunCliLauncher,
  resolveBunGlobalBinDir,
} from "../../scripts/lib/bun-cli-launcher.mjs";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveBunGlobalInstallOwner } from "../infra/detect-package-manager.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function hasPersistentNode(): boolean {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const executable = path.resolve(directory || ".", "node");
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      if (!fs.statSync(executable).isFile()) {
        continue;
      }
      // `bun --bun` supplies a temporary Node alias, not a future CLI runtime.
      if (
        /^bun-node-(?:[0-9a-f]+|[0-9]+-(?:[0-9a-f]+|debug)(?:-[0-9a-f]{16})?)$/u.test(
          path.basename(path.dirname(executable)),
        ) &&
        fs.realpathSync(executable) === fs.realpathSync(process.execPath)
      ) {
        continue;
      }
      return true;
    } catch {
      // PATH lookup skips absent or nonexecutable candidates without spawning them.
    }
  }
  return false;
}

export async function noteBunCliLauncherIssues(params: {
  root: string | null;
  prompter: Pick<DoctorPrompter, "confirmAutoFix" | "repairMode">;
}): Promise<void> {
  if (
    !params.root ||
    !process.versions.bun ||
    process.platform === "win32" ||
    params.prompter.repairMode.updateInProgress ||
    hasPersistentNode()
  ) {
    return;
  }
  const owner = resolveBunGlobalInstallOwner(params.root);
  if (!owner) {
    return;
  }
  const entryPath = path.join(params.root, "openclaw.mjs");
  const pathIssue = getBunCliLauncherPathIssue({ bunPath: process.execPath, entryPath });
  if (pathIssue) {
    const command = `${quoteCliArg(process.execPath)} ${quoteCliArg(entryPath)}`;
    note(`${pathIssue}. Run ${command} instead.`, "Bun CLI launcher");
    return;
  }
  try {
    const binDir = resolveBunGlobalBinDir({
      bunPath: process.execPath,
      cwd: owner.globalProjectRoot,
      env: {
        ...process.env,
        BUN_INSTALL_GLOBAL_DIR: owner.globalProjectRoot,
        ...(owner.bunInstall ? { BUN_INSTALL: owner.bunInstall } : {}),
      },
    });
    const launcher = { packageRoot: params.root, bunPath: process.execPath, binDir };
    const inspection = inspectBunCliLauncher(launcher);
    if (inspection.state === "current") {
      return;
    }
    if (inspection.state === "conflict") {
      note(
        `The openclaw command at ${inspection.path} belongs to another installation. Resolve the conflicting command before repairing this Bun installation.`,
        "Bun CLI launcher",
      );
      return;
    }
    note(
      `The Bun CLI launcher is ${inspection.state}: ${inspection.path}. The openclaw command needs a launcher that uses this installation's Bun executable.`,
      "Bun CLI launcher",
    );
    if (
      !(await params.prompter.confirmAutoFix({
        message: "Repair the openclaw command for this Bun installation?",
        initialValue: false,
      }))
    ) {
      return;
    }
    const installed = installBunCliLauncher(launcher);
    note(`Repaired the Bun CLI launcher: ${installed.path}`, "Bun CLI launcher");
  } catch (error) {
    note(
      `Could not repair the Bun CLI launcher: ${error instanceof Error ? error.message : String(error)}. Run Doctor with --fix through this package's Bun entry point after resolving the problem.`,
      "Bun CLI launcher",
    );
  }
}
