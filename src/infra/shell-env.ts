import { execFileSync } from "node:child_process";
import path from "node:path";
import { isTruthyEnvValue } from "./env.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
let lastAppliedKeys: string[] = [];
let cachedShellPath: string | null | undefined;

function resolveShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  return shell && shell.length > 0 ? shell : "/bin/sh";
}

/**
 * Build a command that sources the appropriate RC file(s) before dumping
 * the environment with `env -0`. Login shells (`-l`) source profile files
 * (.zprofile, .bash_profile) but skip interactive RC files (.zshrc, .bashrc)
 * where tools like pyenv/nvm/rbenv are commonly configured. This helper
 * explicitly sources those RC files so their PATH modifications are captured.
 */
export function buildEnvDumpCommand(shell: string): string {
  const base = path.basename(shell);

  switch (base) {
    case "zsh":
      return '{ . "$HOME/.zshrc"; } >/dev/null 2>&1 || true; env -0';
    case "bash":
      return '{ . "$HOME/.bashrc"; } >/dev/null 2>&1 || true; env -0';
    case "fish":
      return 'set -q XDG_CONFIG_HOME; or set -l XDG_CONFIG_HOME "$HOME/.config"; source "$XDG_CONFIG_HOME/fish/config.fish" 2>/dev/null; env -0';
    case "ksh":
    case "ksh93":
    case "mksh":
      return '{ . "$HOME/.kshrc"; } >/dev/null 2>&1 || true; env -0';
    case "tcsh":
      // tcsh reads ~/.tcshrc first, falls back to ~/.cshrc
      return "if ( -f ~/.tcshrc ) then; source ~/.tcshrc >& /dev/null; else; source ~/.cshrc >& /dev/null; endif; env -0";
    case "csh":
      return "source ~/.cshrc >& /dev/null; env -0";
    case "nu":
      // nushell: -l already sources env.nu (where PATH goes); config.nu
      // cannot be conditionally sourced (parser directive). ^env calls
      // the external env binary.
      return "^env -0";
    case "elvish":
      return "try { eval (slurp < ~/.config/elvish/rc.elv) } catch e { nop }; env -0";
    case "xonsh":
      // xonsh -l already sources ~/.xonshrc for both login and interactive
      return "env -0";
    case "pwsh":
    case "powershell":
      return "try { . $PROFILE } catch {}; & env -0";
    default:
      return 'for f in "$HOME/.bashrc" "$HOME/.zshrc"; do [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true; done; env -0';
  }
}

function parseShellEnv(stdout: Buffer): Map<string, string> {
  const shellEnv = new Map<string, string>();
  const parts = stdout.toString("utf8").split("\0");
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!key) {
      continue;
    }
    shellEnv.set(key, value);
  }
  return shellEnv;
}

export type ShellEnvFallbackResult =
  | { ok: true; applied: string[]; skippedReason?: never }
  | { ok: true; applied: []; skippedReason: "already-has-keys" | "disabled" }
  | { ok: false; error: string; applied: [] };

export type ShellEnvFallbackOptions = {
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  expectedKeys: string[];
  logger?: Pick<typeof console, "warn">;
  timeoutMs?: number;
  exec?: typeof execFileSync;
};

export function loadShellEnvFallback(opts: ShellEnvFallbackOptions): ShellEnvFallbackResult {
  const logger = opts.logger ?? console;
  const exec = opts.exec ?? execFileSync;

  if (!opts.enabled) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "disabled" };
  }

  const hasAnyKey = opts.expectedKeys.some((key) => Boolean(opts.env[key]?.trim()));
  if (hasAnyKey) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "already-has-keys" };
  }

  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(0, opts.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  const shell = resolveShell(opts.env);

  let stdout: Buffer;
  try {
    stdout = exec(shell, ["-l", "-c", buildEnvDumpCommand(shell)], {
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[openclaw] shell env fallback failed: ${msg}`);
    lastAppliedKeys = [];
    return { ok: false, error: msg, applied: [] };
  }

  const shellEnv = parseShellEnv(stdout);

  const applied: string[] = [];
  for (const key of opts.expectedKeys) {
    if (opts.env[key]?.trim()) {
      continue;
    }
    const value = shellEnv.get(key);
    if (!value?.trim()) {
      continue;
    }
    opts.env[key] = value;
    applied.push(key);
  }

  lastAppliedKeys = applied;
  return { ok: true, applied };
}

export function shouldEnableShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_LOAD_SHELL_ENV);
}

export function shouldDeferShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK);
}

export function resolveShellEnvFallbackTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_SHELL_ENV_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, parsed);
}

export function getShellPathFromLoginShell(opts: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
}): string | null {
  if (cachedShellPath !== undefined) {
    return cachedShellPath;
  }
  if (process.platform === "win32") {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const exec = opts.exec ?? execFileSync;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(0, opts.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const shell = resolveShell(opts.env);

  let stdout: Buffer;
  try {
    stdout = exec(shell, ["-l", "-c", buildEnvDumpCommand(shell)], {
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const shellEnv = parseShellEnv(stdout);
  const shellPath = shellEnv.get("PATH")?.trim();
  cachedShellPath = shellPath && shellPath.length > 0 ? shellPath : null;
  return cachedShellPath;
}

export function resetShellPathCacheForTests(): void {
  cachedShellPath = undefined;
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedKeys];
}
