export const POSIX_INLINE_COMMAND_FLAGS = new Set(["-lc", "-c", "--command"]);
export const POWERSHELL_INLINE_COMMAND_FLAGS = new Set(["-c", "-command", "--command"]);

// Bash options that require a following argument
// Ref: https://www.gnu.org/software/bash/manual/html_node/Invoking-Bash.html
const BASH_OPTIONS_WITH_VALUE = new Set([
  "-o",       // set -o option-name
  "-O",       // set shell option (shopt)
  "--rcfile", // startup file
  "--init-file", // startup file (alias for --rcfile)
]);

export function resolveInlineCommandMatch(
  argv: string[],
  flags: ReadonlySet<string>,
  options: { allowCombinedC?: boolean } = {},
): { command: string | null; valueTokenIndex: number | null } {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "--") {
      break;
    }
    if (flags.has(lower)) {
      const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
      const command = argv[i + 1]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
    if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
      const commandIndex = lower.indexOf("c");
      const inline = token.slice(commandIndex + 1).trim();
      if (inline) {
        return { command: inline, valueTokenIndex: i };
      }
      const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
      const command = argv[i + 1]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
  }
  return { command: null, valueTokenIndex: null };
}

/**
 * Extract the script path from a POSIX shell invocation (e.g., bash, sh, zsh).
 * For example:
 *   bash -o pipefail script.sh  → "script.sh"
 *   bash script.sh              → "script.sh"
 *   bash -c "echo hi"           → null (inline command, not a script file)
 * 
 * This function returns the first positional argument after skipping:
 * 1. Options that require a value (e.g., -o, -O, --rcfile, --init-file)
 * 2. Flag-only options (e.g., -l, -i, -s, -x)
 * 3. Inline command flags (-c, -lc, --command) - these mean no script file
 */
export function extractPosixShellScriptPath(argv: string[]): string | null {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]?.trim();
    if (!token) {
      i += 1;
      continue;
    }
    
    const lower = token.toLowerCase();
    
    // End of options marker
    if (lower === "--") {
      i += 1;
      break;
    }
    
    // Inline command flags mean there's no script file
    if (POSIX_INLINE_COMMAND_FLAGS.has(lower)) {
      return null;
    }
    
    // Combined flags like -lc also indicate inline command
    if (/^-[^-]*c[^-]*$/i.test(token)) {
      return null;
    }
    
    // Not an option, this is the script path
    if (!token.startsWith("-")) {
      return token;
    }
    
    // Long option with inline value (e.g., --rcfile=file.sh)
    if (token.startsWith("--") && token.includes("=")) {
      i += 1;
      continue;
    }
    
    // Options that require a following value
    if (BASH_OPTIONS_WITH_VALUE.has(lower)) {
      i += 2; // Skip both the option and its value
      continue;
    }
    
    // Flag-only options (e.g., -l, -i, -s, -x, -v, -d)
    // These are single-letter flags that don't take values
    i += 1;
  }
  
  // Return the first remaining positional argument
  if (i < argv.length) {
    const scriptPath = argv[i]?.trim();
    return scriptPath && scriptPath.length > 0 ? scriptPath : null;
  }
  
  return null;
}
