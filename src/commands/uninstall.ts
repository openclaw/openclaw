import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import { hasBinary } from "../agents/skills.js";
import { isNixMode } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveHomeDir } from "../utils.js";
import { resolveCleanupPlanFromDisk } from "./cleanup-plan.js";
import { removePath, removeStateAndLinkedPaths, removeWorkspaceDirs } from "./cleanup-utils.js";

type UninstallScope = "service" | "state" | "workspace" | "app";

export type UninstallOptions = {
  service?: boolean;
  state?: boolean;
  workspace?: boolean;
  app?: boolean;
  all?: boolean;
  zap?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

const multiselectStyled = <T>(params: Parameters<typeof multiselect<T>>[0]) =>
  multiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

function buildScopeSelection(opts: UninstallOptions): {
  scopes: Set<UninstallScope>;
  hadExplicit: boolean;
} {
  const hadExplicit = Boolean(
    opts.all || opts.zap || opts.service || opts.state || opts.workspace || opts.app,
  );
  const scopes = new Set<UninstallScope>();
  if (opts.all || opts.zap || opts.service) {
    scopes.add("service");
  }
  if (opts.all || opts.zap || opts.state) {
    scopes.add("state");
  }
  if (opts.all || opts.zap || opts.workspace) {
    scopes.add("workspace");
  }
  if (opts.all || opts.zap || opts.app) {
    scopes.add("app");
  }
  return { scopes, hadExplicit };
}

async function stopAndUninstallService(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    runtime.error("Nix mode detected; service uninstall is disabled.");
    return false;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`Gateway service check failed: ${String(err)}`);
    return false;
  }
  if (!loaded) {
    runtime.log(`Gateway service ${service.notLoadedText}.`);
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(`Gateway stop failed: ${String(err)}`);
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(`Gateway uninstall failed: ${String(err)}`);
    return false;
  }
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean) {
  if (process.platform !== "darwin") {
    return;
  }
  await removePath("/Applications/OpenClaw.app", runtime, {
    dryRun,
    label: "/Applications/OpenClaw.app",
  });
}

const COMPLETION_PROFILE_HEADER = "# OpenClaw Completion";

function shouldRemoveCompletionProfileLine(line: string): boolean {
  if (line.trim() === COMPLETION_PROFILE_HEADER) {
    return true;
  }
  const normalizedLine = line.replaceAll("\\", "/");
  return (
    normalizedLine.includes("openclaw completion") ||
    normalizedLine.includes("/completions/openclaw.")
  );
}

async function cleanupShellCompletionTraces(runtime: RuntimeEnv, dryRun?: boolean) {
  const home = os.homedir();
  const profilePaths = [
    path.join(home, ".zshrc"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".config", "fish", "config.fish"),
    path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1"),
  ];
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || home;
    profilePaths.push(
      path.join(userProfile, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    );
  }
  for (const profilePath of profilePaths) {
    let content = "";
    try {
      content = await fs.readFile(profilePath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const nextLines = lines.filter((line) => !shouldRemoveCompletionProfileLine(line));
    const next = nextLines.join("\n");
    if (next === content) {
      continue;
    }
    if (dryRun) {
      runtime.log(`[dry-run] update ${profilePath} (remove OpenClaw completion lines)`);
      continue;
    }
    try {
      await fs.writeFile(profilePath, next, "utf-8");
      runtime.log(`Updated ${profilePath} (removed OpenClaw completion lines)`);
    } catch (err) {
      runtime.error(`Failed to update ${profilePath}: ${String(err)}`);
    }
  }

  const completionArtifacts = [
    path.join(home, ".zsh", "completions", "_openclaw"),
    path.join(home, ".oh-my-zsh", "completions", "_openclaw"),
    path.join(home, ".local", "share", "bash-completion", "completions", "openclaw"),
    path.join(home, ".config", "fish", "completions", "openclaw.fish"),
  ];
  for (const artifactPath of completionArtifacts) {
    await removePath(artifactPath, runtime, { dryRun, label: artifactPath });
  }
}

type ZapUninstallCommand = {
  manager: "npm" | "pnpm" | "bun";
  argv: string[];
};

const ZAP_UNINSTALL_COMMANDS: readonly ZapUninstallCommand[] = [
  { manager: "npm", argv: ["npm", "rm", "-g", "openclaw"] },
  { manager: "pnpm", argv: ["pnpm", "remove", "-g", "openclaw"] },
  { manager: "bun", argv: ["bun", "remove", "-g", "openclaw"] },
];

function isNotInstalledMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("not installed") ||
    lower.includes("no packages found") ||
    lower.includes("could not find")
  );
}

async function runZapCliUninstall(runtime: RuntimeEnv, dryRun?: boolean) {
  for (const command of ZAP_UNINSTALL_COMMANDS) {
    if (!hasBinary(command.manager)) {
      continue;
    }
    const pretty = command.argv.join(" ");
    if (dryRun) {
      runtime.log(`[dry-run] run ${pretty}`);
      continue;
    }
    const result = await runCommandWithTimeout(command.argv, { timeoutMs: 120_000 });
    if (result.code === 0) {
      runtime.log(`Ran ${pretty}`);
      continue;
    }
    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (output && isNotInstalledMessage(output)) {
      runtime.log(`Skipped ${pretty} (openclaw not installed for ${command.manager}).`);
      continue;
    }
    runtime.error(`Failed ${pretty}: ${output || `exit code ${String(result.code ?? "unknown")}`}`);
  }
}

async function runZapCleanup(runtime: RuntimeEnv, opts: { dryRun?: boolean }) {
  await runZapCliUninstall(runtime, opts.dryRun);
  await cleanupShellCompletionTraces(runtime, opts.dryRun);
}

export async function uninstallCommand(runtime: RuntimeEnv, opts: UninstallOptions) {
  const { scopes, hadExplicit } = buildScopeSelection(opts);
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error("Non-interactive mode requires --yes.");
    runtime.exit(1);
    return;
  }

  if (!hadExplicit) {
    if (!interactive) {
      runtime.error("Non-interactive mode requires explicit scopes (use --all).");
      runtime.exit(1);
      return;
    }
    const selection = await multiselectStyled<UninstallScope>({
      message: "Uninstall which components?",
      options: [
        {
          value: "service",
          label: "Gateway service",
          hint: "launchd / systemd / schtasks",
        },
        { value: "state", label: "State + config", hint: "~/.openclaw" },
        { value: "workspace", label: "Workspace", hint: "agent files" },
        {
          value: "app",
          label: "macOS app",
          hint: "/Applications/OpenClaw.app",
        },
      ],
      initialValues: ["service", "state", "workspace"],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
      runtime.exit(0);
      return;
    }
    for (const value of selection) {
      scopes.add(value);
    }
  }

  if (scopes.size === 0) {
    runtime.log("Nothing selected.");
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage("Proceed with uninstall?"),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
    resolveCleanupPlanFromDisk();

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log("[dry-run] remove gateway service");
    } else {
      await stopAndUninstallService(runtime);
    }
  }

  if (scopes.has("state")) {
    await removeStateAndLinkedPaths(
      { stateDir, configPath, oauthDir, configInsideState, oauthInsideState },
      runtime,
      { dryRun },
    );
  }

  if (scopes.has("workspace")) {
    await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
  }

  if (scopes.has("app")) {
    await removeMacApp(runtime, dryRun);
  }

  if (opts.zap) {
    await runZapCleanup(runtime, { dryRun });
  }

  if (opts.zap) {
    runtime.log("Zap mode attempted to remove CLI installs and shell completion traces.");
  } else {
    runtime.log("CLI still installed. Remove via npm/pnpm if desired.");
  }

  if (scopes.has("state") && !scopes.has("workspace")) {
    const home = resolveHomeDir();
    if (home && workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) {
      runtime.log("Tip: workspaces were preserved. Re-run with --workspace to remove them.");
    }
  }
}
