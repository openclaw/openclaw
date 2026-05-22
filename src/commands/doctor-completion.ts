import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveCliName } from "../cli/cli-name.js";
import {
  completionCacheExists,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "../cli/completion-runtime.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type CompletionShell = "zsh" | "bash" | "fish" | "powershell";

const COMPLETION_CACHE_WRITE_TIMEOUT_MS = 30_000;

function resolveCompletionReloadPath(shell: CompletionShell): string {
  if (shell === "powershell") {
    return resolveCompletionProfilePath("powershell");
  }
  return `~/.${shell === "zsh" ? "zshrc" : shell === "bash" ? "bashrc" : "config/fish/config.fish"}`;
}

/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache(): Promise<boolean> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return false;
  }

  const binPath = path.join(root, "openclaw.mjs");
  const result = spawnSync(process.execPath, [binPath, "completion", "--write-state"], {
    cwd: root,
    env: process.env,
    encoding: "utf-8",
    timeout: COMPLETION_CACHE_WRITE_TIMEOUT_MS,
  });

  return result.status === 0;
}

export type ShellCompletionStatus = {
  shell: CompletionShell;
  profileInstalled: boolean;
  cacheExists: boolean;
  cachePath: string;
  /** True if profile uses slow dynamic pattern like `source <(openclaw completion ...)` */
  usesSlowPattern: boolean;
};

type ShellCompletionDoctorOptions = {
  nonInteractive?: boolean;
};

type ShellCompletionRepairDeps = {
  status?: ShellCompletionStatus;
  generateCompletionCache?: () => Promise<boolean>;
  installCompletion?: typeof installCompletion;
  confirm?: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
};

/** Check the status of shell completion for the current shell. */
export async function checkShellCompletionStatus(
  binName = "openclaw",
): Promise<ShellCompletionStatus> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const profileInstalled = await isCompletionInstalled(shell, binName);
  const cacheExists = await completionCacheExists(shell, binName);
  const cachePath = resolveCompletionCachePath(shell, binName);
  const usesSlowPattern = await usesSlowDynamicCompletion(shell, binName);

  return {
    shell,
    profileInstalled,
    cacheExists,
    cachePath,
    usesSlowPattern,
  };
}

function formatCompletionRestartCommand(shell: CompletionShell): string {
  return formatCompletionReloadCommand(shell, resolveCompletionReloadPath(shell));
}

export function shellCompletionStatusToHealthFindings(
  status: ShellCompletionStatus,
  options: ShellCompletionDoctorOptions = {},
) {
  const checkId = "core/doctor/shell-completion";
  const path = `shellCompletion.${status.shell}`;
  if (status.usesSlowPattern) {
    return [
      {
        checkId,
        severity: "warning" as const,
        message: `Your ${status.shell} profile uses slow dynamic completion (source <(...)).`,
        path,
        fixHint: "Run `openclaw doctor --fix` to upgrade to cached completion.",
      },
    ];
  }
  if (status.profileInstalled && !status.cacheExists) {
    return [
      {
        checkId,
        severity: "warning" as const,
        message: `Shell completion is configured in your ${status.shell} profile but the cache is missing.`,
        path,
        fixHint: `Run \`openclaw completion --write-state\` or \`openclaw doctor --fix\` to regenerate ${status.cachePath}.`,
      },
    ];
  }
  if (!status.profileInstalled && options.nonInteractive !== true) {
    return [
      {
        checkId,
        severity: "info" as const,
        message: `Shell completion is not installed for ${status.shell}.`,
        path,
        fixHint: "Run `openclaw doctor --fix` to install cached shell completion.",
      },
    ];
  }
  return [];
}

export async function detectShellCompletionHealth(
  options: ShellCompletionDoctorOptions = {},
): Promise<ReturnType<typeof shellCompletionStatusToHealthFindings>> {
  const cliName = resolveCliName();
  return shellCompletionStatusToHealthFindings(await checkShellCompletionStatus(cliName), options);
}

export async function repairShellCompletionHealth(params: {
  options?: ShellCompletionDoctorOptions;
  deps?: ShellCompletionRepairDeps;
}): Promise<{ status?: "repaired" | "skipped" | "failed"; changes: string[]; warnings: string[] }> {
  const cliName = resolveCliName();
  const status = params.deps?.status ?? (await checkShellCompletionStatus(cliName));
  const generateCache = params.deps?.generateCompletionCache ?? generateCompletionCache;
  const install = params.deps?.installCompletion ?? installCompletion;
  const confirmInstall = params.deps?.confirm;
  const changes: string[] = [];
  const warnings: string[] = [];

  if (status.usesSlowPattern) {
    if (!status.cacheExists && !(await generateCache())) {
      return {
        status: "failed",
        changes,
        warnings: [
          `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
        ],
      };
    }
    await install(status.shell, true, cliName);
    changes.push(
      `Shell completion upgraded. Restart your shell or run: ${formatCompletionRestartCommand(status.shell)}`,
    );
    return { changes, warnings };
  }

  if (status.profileInstalled && !status.cacheExists) {
    if (await generateCache()) {
      changes.push(`Completion cache regenerated at ${status.cachePath}`);
      return { changes, warnings };
    }
    return {
      status: "failed",
      changes,
      warnings: [
        `Failed to regenerate completion cache. Run \`${cliName} completion --write-state\` manually.`,
      ],
    };
  }

  if (!status.profileInstalled) {
    if (params.options?.nonInteractive === true || !confirmInstall) {
      return { status: "skipped", changes, warnings };
    }
    const shouldInstall = await confirmInstall({
      message: `Enable ${status.shell} shell completion for ${cliName}?`,
      initialValue: true,
    });
    if (!shouldInstall) {
      return { status: "skipped", changes, warnings };
    }
    if (!(await generateCache())) {
      return {
        status: "failed",
        changes,
        warnings: [
          `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
        ],
      };
    }
    await install(status.shell, true, cliName);
    changes.push(
      `Shell completion installed. Restart your shell or run: ${formatCompletionRestartCommand(status.shell)}`,
    );
  }

  return { changes, warnings };
}

export type DoctorCompletionOptions = {
  nonInteractive?: boolean;
};

/**
 * Doctor check for shell completion.
 * - If profile uses slow dynamic pattern: upgrade to cached version
 * - If profile has completion but no cache: auto-generate cache and upgrade profile
 * - If no completion at all: prompt to install (with user confirmation)
 */
export async function doctorShellCompletion(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: DoctorCompletionOptions = {},
): Promise<void> {
  const cliName = resolveCliName();
  const status = await checkShellCompletionStatus(cliName);
  const result = await repairShellCompletionHealth({
    options,
    deps: {
      status,
      confirm: (params) => prompter.confirm(params),
    },
  });
  for (const warning of result.warnings) {
    note(warning, "Shell completion");
  }
  for (const change of result.changes) {
    note(change, "Shell completion");
  }
}

/**
 * Ensure completion cache exists. Used during setup/update to fix
 * cases where profile has completion but no cache.
 * This is a silent fix - no prompts.
 */
export async function ensureCompletionCacheExists(binName = "openclaw"): Promise<boolean> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const cacheExists = await completionCacheExists(shell, binName);

  if (cacheExists) {
    return true;
  }

  return generateCompletionCache();
}
