import { Command, Option } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { pathExists } from "../utils.js";
import { getSubCliEntries, registerSubCliByName } from "./program/register.subclis.js";

const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
type CompletionShell = (typeof COMPLETION_SHELLS)[number];

function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

export function resolveShellFromEnv(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellPath = env.SHELL?.trim() ?? "";
  const shellName = shellPath ? path.basename(shellPath).toLowerCase() : "";
  if (shellName === "zsh") {
    return "zsh";
  }
  if (shellName === "bash") {
    return "bash";
  }
  if (shellName === "fish") {
    return "fish";
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return "powershell";
  }
  return "zsh";
}

function sanitizeCompletionBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "openclaw";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resolveCompletionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "completions");
}

export function resolveCompletionCachePath(shell: CompletionShell, binName: string): string {
  const basename = sanitizeCompletionBasename(binName);
  const extension =
    shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
  return path.join(resolveCompletionCacheDir(), `${basename}.${extension}`);
}

/** Check if the completion cache file exists for the given shell. */
export async function completionCacheExists(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const cachePath = resolveCompletionCachePath(shell, binName);
  return pathExists(cachePath);
}

function getCompletionScript(shell: CompletionShell, program: Command): string {
  if (shell === "zsh") {
    return generateZshCompletion(program);
  }
  if (shell === "bash") {
    return generateBashCompletion(program);
  }
  if (shell === "powershell") {
    return generatePowerShellCompletion(program);
  }
  return generateFishCompletion(program);
}

async function writeCompletionCache(params: {
  program: Command;
  shells: CompletionShell[];
  binName: string;
}): Promise<void> {
  const cacheDir = resolveCompletionCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  for (const shell of params.shells) {
    const script = getCompletionScript(shell, params.program);
    const targetPath = resolveCompletionCachePath(shell, params.binName);
    await fs.writeFile(targetPath, script, "utf-8");
  }
}

function formatCompletionSourceLine(
  shell: CompletionShell,
  binName: string,
  cachePath: string,
): string {
  if (shell === "fish") {
    return `source "${cachePath}"`;
  }
  return `source "${cachePath}"`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# OpenClaw Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string | null): boolean {
  if (line.includes(`${binName} completion`)) {
    return true;
  }
  if (cachePath && line.includes(cachePath)) {
    return true;
  }
  return false;
}

/** Check if a line uses the slow dynamic completion pattern (source <(...)) */
function isSlowDynamicCompletionLine(line: string, binName: string): boolean {
  // Matches patterns like: source <(openclaw completion --shell zsh)
  return (
    line.includes(`<(${binName} completion`) ||
    (line.includes(`${binName} completion`) && line.includes("| source"))
  );
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string | null,
  sourceLine: string,
): { next: string; changed: boolean; hadExisting: boolean } {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      i += 1;
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# OpenClaw Completion\n${sourceLine}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

function getShellProfilePath(shell: CompletionShell): string {
  const home = process.env.HOME || os.homedir();
  if (shell === "zsh") {
    return path.join(home, ".zshrc");
  }
  if (shell === "bash") {
    return path.join(home, ".bashrc");
  }
  if (shell === "fish") {
    return path.join(home, ".config", "fish", "config.fish");
  }
  // PowerShell
  if (process.platform === "win32") {
    return path.join(
      process.env.USERPROFILE || home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = getShellProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const cachePathCandidate = resolveCompletionCachePath(shell, binName);
  const cachedPath = (await pathExists(cachePathCandidate)) ? cachePathCandidate : null;
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");
  return lines.some(
    (line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, cachedPath),
  );
}

/**
 * Check if the profile uses the slow dynamic completion pattern.
 * Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
 */
export async function usesSlowDynamicCompletion(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = getShellProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");

  // Check if any line has dynamic completion but NOT the cached path
  for (const line of lines) {
    if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) {
      return true;
    }
  }
  return false;
}

export function registerCompletionCli(program: Command) {
  program
    .command("completion")
    .description("Generate shell completion script")
    .addOption(
      new Option("-s, --shell <shell>", "Shell to generate completion for (default: zsh)").choices(
        COMPLETION_SHELLS,
      ),
    )
    .option("-i, --install", "Install completion script to shell profile")
    .option(
      "--write-state",
      "Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)",
    )
    .option("-y, --yes", "Skip confirmation (non-interactive)", false)
    .action(async (options) => {
      const shell = options.shell ?? "zsh";
      // Eagerly register all subcommands to build the full tree
      const entries = getSubCliEntries();
      for (const entry of entries) {
        // Skip completion command itself to avoid cycle if we were to add it to the list
        if (entry.name === "completion") {
          continue;
        }
        await registerSubCliByName(program, entry.name);
      }

      if (options.writeState) {
        const writeShells = options.shell ? [shell] : [...COMPLETION_SHELLS];
        await writeCompletionCache({
          program,
          shells: writeShells,
          binName: program.name(),
        });
      }

      if (options.install) {
        const targetShell = options.shell ?? resolveShellFromEnv();
        await installCompletion(targetShell, Boolean(options.yes), program.name());
        return;
      }

      if (options.writeState) {
        return;
      }

      if (!isCompletionShell(shell)) {
        throw new Error(`Unsupported shell: ${shell}`);
      }
      const script = getCompletionScript(shell, program);
      console.log(script);
    });
}

export async function installCompletion(shell: string, yes: boolean, binName = "openclaw") {
  const home = process.env.HOME || os.homedir();
  let profilePath = "";
  let sourceLine = "";

  const isShellSupported = isCompletionShell(shell);
  if (!isShellSupported) {
    console.error(`Automated installation not supported for ${shell} yet.`);
    return;
  }

  // Get the cache path - cache MUST exist for fast shell startup
  const cachePath = resolveCompletionCachePath(shell, binName);
  const cacheExists = await pathExists(cachePath);
  if (!cacheExists) {
    console.error(
      `Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`,
    );
    return;
  }

  if (shell === "zsh") {
    profilePath = path.join(home, ".zshrc");
    sourceLine = formatCompletionSourceLine("zsh", binName, cachePath);
  } else if (shell === "bash") {
    // Try .bashrc first, then .bash_profile
    profilePath = path.join(home, ".bashrc");
    try {
      await fs.access(profilePath);
    } catch {
      profilePath = path.join(home, ".bash_profile");
    }
    sourceLine = formatCompletionSourceLine("bash", binName, cachePath);
  } else if (shell === "fish") {
    profilePath = path.join(home, ".config", "fish", "config.fish");
    sourceLine = formatCompletionSourceLine("fish", binName, cachePath);
  } else {
    console.error(`Automated installation not supported for ${shell} yet.`);
    return;
  }

  try {
    // Check if profile exists
    try {
      await fs.access(profilePath);
    } catch {
      if (!yes) {
        console.warn(`Profile not found at ${profilePath}. Created a new one.`);
      }
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, "", "utf-8");
    }

    const content = await fs.readFile(profilePath, "utf-8");
    const update = updateCompletionProfile(content, binName, cachePath, sourceLine);
    if (!update.changed) {
      if (!yes) {
        console.log(`Completion already installed in ${profilePath}`);
      }
      return;
    }

    if (!yes) {
      const action = update.hadExisting ? "Updating" : "Installing";
      console.log(`${action} completion in ${profilePath}...`);
    }

    await fs.writeFile(profilePath, update.next, "utf-8");
    if (!yes) {
      console.log(`Completion installed. Restart your shell or run: source ${profilePath}`);
    }
  } catch (err) {
    console.error(`Failed to install completion: ${err as string}`);
  }
}

function generateZshCompletion(program: Command): string {
  const rootCmd = program.name();
  const script = `
#compdef ${rootCmd}

_${rootCmd}_root_completion() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(program)} \\
    ${generateZshSubcmdList(program)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${program.commands.map((cmd) => `(${cmd.name()}) _${rootCmd}_${cmd.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}

${generateZshSubcommands(program, rootCmd)}

# Guard: ensure compinit has been run before calling compdef.
# Prevents "command not found: compdef" when sourced before compinit in .zshrc.
# See: https://github.com/openclaw/openclaw/issues/14289
if (( $+functions[compdef] )); then
  compdef _${rootCmd}_root_completion ${rootCmd}
else
  # Queue the compdef for after compinit runs
  autoload -Uz compinit
  _${rootCmd}_deferred_compdef() {
    compdef _${rootCmd}_root_completion ${rootCmd}
    unfunction _${rootCmd}_deferred_compdef 2>/dev/null
  }
  precmd_functions+=(_${rootCmd}_deferred_compdef)
fi
`;
  return script;
}

function generateZshArgs(cmd: Command): string {
  return (cmd.options || [])
    .map((opt) => {
      const flags = opt.flags.split(/[ ,|]+/);
      const name = flags.find((f) => f.startsWith("--")) || flags[0];
      const short = flags.find((f) => f.startsWith("-") && !f.startsWith("--"));
      const desc = opt.description
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/'/g, "'\\''")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
      if (short) {
        return `"(${name} ${short})"{${name},${short}}"[${desc}]"`;
      }
      return `"${name}[${desc}]"`;
    })
    .join(" \\\n    ");
}

function generateZshSubcmdList(cmd: Command): string {
  const list = cmd.commands
    .map((c) => {
      const desc = c
        .description()
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "'\\''")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
      return `'${c.name()}[${desc}]'`;
    })
    .join(" ");
  return `"1: :_values 'command' ${list}"`;
}

function generateZshSubcommands(program: Command, prefix: string): string {
  let script = "";
  for (const cmd of program.commands) {
    const cmdName = cmd.name();
    const funcName = `_${prefix}_${cmdName.replace(/-/g, "_")}`;

    // Recurse first
    script += generateZshSubcommands(cmd, `${prefix}_${cmdName.replace(/-/g, "_")}`);

    const subCommands = cmd.commands;
    if (subCommands.length > 0) {
      script += `
${funcName}() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(cmd)} \\
    ${generateZshSubcmdList(cmd)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${subCommands.map((sub) => `(${sub.name()}) ${funcName}_${sub.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}
`;
    } else {
      script += `
${funcName}() {
  _arguments -C \\
    ${generateZshArgs(cmd)}
}
`;
    }
  }
  return script;
}

function generateBashCompletion(program: Command): string {
  // Simplified Bash completion using dynamic iteration logic (often hardcoded in static scripts)
  // For a robust implementation, usually one maps out the tree.
  // This assumes a simple structure.
  const rootCmd = program.name();

  // We can use a recursive function to build the case statements
  return `
_${rootCmd}_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    
    # Simple top-level completion for now
    opts="${program.commands.map((c) => c.name()).join(" ")} ${program.options.map((o) => o.flags.split(" ")[0]).join(" ")}"
    
    case "\${prev}" in
      ${program.commands.map((cmd) => generateBashSubcommand(cmd)).join("\n      ")}
    esac

    if [[ \${cur} == -* ]] ; then
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
    fi
    
    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}

complete -F _${rootCmd}_completion ${rootCmd}
`;
}

function generateBashSubcommand(cmd: Command): string {
  // This is a naive implementation; fully recursive bash completion is complex to generate as a single string without improved state tracking.
  // For now, let's provide top-level command recognition.
  return `${cmd.name()})
        opts="${cmd.commands.map((c) => c.name()).join(" ")} ${cmd.options.map((o) => o.flags.split(" ")[0]).join(" ")}"
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
        ;;`;
}

function generatePowerShellCompletion(program: Command): string {
  const rootCmd = program.name();

  const visit = (cmd: Command, parents: string[]): string => {
    const cmdName = cmd.name();
    const fullPath = [...parents, cmdName].join(" ");

    let script = "";

    // Command completion for this level
    const subCommands = cmd.commands.map((c) => c.name());
    const options = cmd.options.map((o) => o.flags.split(/[ ,|]+/)[0]); // Take first flag
    const allCompletions = [...subCommands, ...options].map((s) => `'${s}'`).join(",");

    if (allCompletions.length > 0) {
      script += `
            if ($commandPath -eq '${fullPath}') {
                $completions = @(${allCompletions})
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`;
    }

    // Recurse
    for (const sub of cmd.commands) {
      script += visit(sub, [...parents, cmdName]);
    }

    return script;
  };

  const rootBody = visit(program, []);

  return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $commandElements = $commandAst.CommandElements
    $commandPath = ""
    
    # Reconstruct command path (simple approximation)
    # Skip the executable name
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i].Extent.Text
        if ($element -like "-*") { break }
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break } # Don't include current word being typed
        $commandPath += "$element "
    }
    $commandPath = $commandPath.Trim()
    
    # Root command
    if ($commandPath -eq "") {
         $completions = @(${program.commands.map((c) => `'${c.name()}'`).join(",")}, ${program.options.map((o) => `'${o.flags.split(" ")[0]}'`).join(",")}) 
         $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
         }
    }
    
    ${rootBody}
}
`;
}

function generateFishCompletion(program: Command): string {
  const rootCmd = program.name();
  let script = "";

  const visit = (cmd: Command, parents: string[]) => {
    const cmdName = cmd.name();
    const fullPath = [...parents];
    if (parents.length > 0) {
      fullPath.push(cmdName);
    } // Only push if not root, or consistent root handling

    // Fish uses 'seen_subcommand_from' to determine context.
    // For root: complete -c openclaw -n "__fish_use_subcommand" -a "subcmd" -d "desc"

    // Root logic
    if (parents.length === 0) {
      // Subcommands of root
      for (const sub of cmd.commands) {
        const desc = sub.description().replace(/'/g, "'\\''");
        script += `complete -c ${rootCmd} -n "__fish_use_subcommand" -a "${sub.name()}" -d '${desc}'\n`;
      }
      // Options of root
      for (const opt of cmd.options) {
        const flags = opt.flags.split(/[ ,|]+/);
        const long = flags.find((f) => f.startsWith("--"))?.replace(/^--/, "");
        const short = flags
          .find((f) => f.startsWith("-") && !f.startsWith("--"))
          ?.replace(/^-/, "");
        const desc = opt.description.replace(/'/g, "'\\''");
        let line = `complete -c ${rootCmd} -n "__fish_use_subcommand"`;
        if (short) {
          line += ` -s ${short}`;
        }
        if (long) {
          line += ` -l ${long}`;
        }
        line += ` -d '${desc}'\n`;
        script += line;
      }
    } else {
      // Nested commands
      // Logic: if seen subcommand matches parents...
      // But fish completion logic is simpler if we just say "if we haven't seen THIS command yet but seen parent"
      // Actually, a robust fish completion often requires defining a function to check current line.
      // For simplicity, we'll assume standard fish helper __fish_seen_subcommand_from.

      // To properly scope to 'openclaw gateway' and not 'openclaw other gateway', we need to check the sequence.
      // A simplified approach:

      // Subcommands
      for (const sub of cmd.commands) {
        const desc = sub.description().replace(/'/g, "'\\''");
        script += `complete -c ${rootCmd} -n "__fish_seen_subcommand_from ${cmdName}" -a "${sub.name()}" -d '${desc}'\n`;
      }
      // Options
      for (const opt of cmd.options) {
        const flags = opt.flags.split(/[ ,|]+/);
        const long = flags.find((f) => f.startsWith("--"))?.replace(/^--/, "");
        const short = flags
          .find((f) => f.startsWith("-") && !f.startsWith("--"))
          ?.replace(/^-/, "");
        const desc = opt.description.replace(/'/g, "'\\''");
        let line = `complete -c ${rootCmd} -n "__fish_seen_subcommand_from ${cmdName}"`;
        if (short) {
          line += ` -s ${short}`;
        }
        if (long) {
          line += ` -l ${long}`;
        }
        line += ` -d '${desc}'\n`;
        script += line;
      }
    }

    for (const sub of cmd.commands) {
      visit(sub, [...parents, cmdName]);
    }
  };

  visit(program, []);
  return script;
}
