import {
  type ExecFileSyncOptionsWithBufferEncoding,
  execFileSync,
  spawn,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { sanitizeHostExecEnv } from "./host-env-security.js";
import { LruCache } from "./lru-cache.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHELL = "/bin/sh";
const LOGIN_SHELL_ENV_COMMAND = "printf '\\0'; env -0";
let lastAppliedKeys: string[] = [];
let cachedShellPath: string | null | undefined;
let cachedEtcShells: Set<string> | null | undefined;
let nextExecCacheId = 1;
const LOGIN_SHELL_ENV_CACHE_LIMIT = 64;
const loginShellEnvProbeCache = new LruCache<Array<[string, string]>>(LOGIN_SHELL_ENV_CACHE_LIMIT);
const pendingShellPathProbes = new Map<string, Promise<string | null>>();
const execCacheIds = new WeakMap<object, number>();
type LoginShellEnvProbePurpose = "environment-import" | "path";

function resolveShellExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const execEnv = sanitizeHostExecEnv({ baseEnv: env });

  // Startup-file resolution must stay pinned to the real user home.
  const home = os.homedir().trim();
  if (home) {
    execEnv.HOME = home;
  } else {
    delete execEnv.HOME;
  }

  // Avoid zsh startup-file redirection via env poisoning.
  delete execEnv.ZDOTDIR;
  return execEnv;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS, 0);
}

function readEtcShells(): Set<string> | null {
  if (cachedEtcShells !== undefined) {
    return cachedEtcShells;
  }
  try {
    const raw = fs.readFileSync("/etc/shells", "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && path.isAbsolute(line));
    cachedEtcShells = new Set(entries);
  } catch {
    cachedEtcShells = null;
  }
  return cachedEtcShells;
}

function isTrustedShellPath(shell: string): boolean {
  if (!path.isAbsolute(shell)) {
    return false;
  }
  const normalized = path.normalize(shell);
  if (normalized !== shell) {
    return false;
  }

  // Primary trust anchor: shell registered in /etc/shells.
  const registeredShells = readEtcShells();
  return registeredShells?.has(shell) === true;
}

function resolveShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  if (shell && isTrustedShellPath(shell)) {
    return shell;
  }
  return DEFAULT_SHELL;
}

type LoginShellExecParams = {
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  purpose: LoginShellEnvProbePurpose;
};

function createLoginShellExecSpec(params: LoginShellExecParams) {
  // Explicit imports reproduce the user's interactive Bash startup; PATH discovery must not run
  // interactive startup files during ordinary command execution.
  const useInteractiveBash =
    params.purpose === "environment-import" && path.basename(params.shell) === "bash";
  const args = useInteractiveBash
    ? ["-lic", LOGIN_SHELL_ENV_COMMAND]
    : ["-l", "-c", LOGIN_SHELL_ENV_COMMAND];
  // Login shells must not take the CLI's controlling terminal. execFileSync forwards
  // detached to spawnSync, but its options type omits it.
  const options: ExecFileSyncOptionsWithBufferEncoding & {
    detached: true;
    maxBuffer: number;
    timeout: number;
    stdio: ["ignore", "pipe", "pipe"];
  } = {
    encoding: "buffer",
    timeout: params.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    env: params.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  };
  return { shell: params.shell, args, options };
}

function execLoginShellEnvZeroAsync(params: LoginShellExecParams): Promise<Buffer> {
  const { shell, args, options } = createLoginShellExecSpec(params);
  return new Promise((resolve, reject) => {
    const deadline = options.timeout > 0 ? performance.now() + options.timeout : undefined;
    let outputTimeout: ReturnType<typeof setTimeout> | undefined;
    // execFile discards stdio and detached. spawn preserves the sync probe's terminal isolation.
    const child = spawn(shell, args, options);
    const discardOutput = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;
    const checkBuffer = (bytes: number) => {
      outputBytes += bytes;
      if (!overflow && outputBytes > options.maxBuffer) {
        overflow = true;
        discardOutput();
        child.kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      checkBuffer(chunk.length);
      if (!overflow) {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      checkBuffer(chunk.length);
    });
    child.once("error", (error) => {
      clearTimeout(outputTimeout);
      discardOutput();
      reject(error);
    });
    child.once("exit", () => {
      // A timed-out shell's descendants must not hold its output pipes open.
      if (child.killed) {
        discardOutput();
      } else if (deadline !== undefined) {
        // spawn clears its timeout on exit, but descendants can retain the output pipes.
        outputTimeout = setTimeout(
          () => {
            reject(new Error("Login-shell environment check timed out"));
            discardOutput();
          },
          Math.max(0, deadline - performance.now()),
        );
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(outputTimeout);
      // spawn owns the timeout; even a shell that exits zero after SIGTERM failed the probe.
      if (overflow || child.killed || signal || code !== 0) {
        reject(new Error("Login-shell environment check failed"));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
  });
}

function parseShellEnv(stdout: Buffer): Map<string, string> {
  const shellEnv = new Map<string, string>();
  // Startup files may write banners before our command. The leading NUL frames the env payload
  // so that banner text cannot become part of its first key.
  const frameEnd = stdout.indexOf(0);
  if (frameEnd < 0) {
    return shellEnv;
  }
  const parts = stdout
    .subarray(frameEnd + 1)
    .toString("utf8")
    .split("\0");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    shellEnv.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return shellEnv;
}

function resolveExecCacheId(exec: typeof execFileSync | undefined): string {
  if (!exec) {
    return "default";
  }
  let id = execCacheIds.get(exec);
  if (!id) {
    id = nextExecCacheId;
    nextExecCacheId += 1;
    execCacheIds.set(exec, id);
  }
  return `exec:${id}`;
}

function createLoginShellEnvCacheKey(
  params: Omit<LoginShellExecParams, "env"> & {
    exec?: typeof execFileSync;
    execEnv: NodeJS.ProcessEnv;
  },
): string {
  const startupEnvEntries = Object.entries(params.execEnv)
    .filter(([key]) => {
      if (
        key === "HOME" ||
        key === "PATH" ||
        key === "TERM" ||
        key === "LANG" ||
        key === "LC_ALL" ||
        key === "LC_CTYPE" ||
        key === "USER" ||
        key === "LOGNAME" ||
        key === "TMPDIR"
      ) {
        return true;
      }
      return key.startsWith("XDG_") || key.startsWith("OPENCLAW_");
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    params.shell,
    params.timeoutMs,
    params.purpose,
    resolveExecCacheId(params.exec),
    startupEnvEntries,
  ]);
}

type LoginShellEnvProbeResult =
  | { ok: true; shellEnv: Map<string, string> }
  | { ok: false; error: string };

function probeLoginShellEnv(
  params: Parameters<typeof getShellPathFromLoginShell>[0] & { purpose: LoginShellEnvProbePurpose },
): LoginShellEnvProbeResult {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    return { ok: true, shellEnv: new Map() };
  }

  const exec = params.exec ?? execFileSync;
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const shell = resolveShell(params.env);
  const execEnv = resolveShellExecEnv(params.env);
  const cacheKey = createLoginShellEnvCacheKey({
    shell,
    timeoutMs,
    exec: params.exec,
    execEnv,
    purpose: params.purpose,
  });
  const cached = loginShellEnvProbeCache.get(cacheKey);
  if (cached) {
    return { ok: true, shellEnv: new Map(cached) };
  }

  try {
    const spec = createLoginShellExecSpec({
      shell,
      env: execEnv,
      timeoutMs,
      purpose: params.purpose,
    });
    const stdout = exec(spec.shell, spec.args, spec.options);
    const shellEnv = parseShellEnv(stdout);
    // Failed startup can recover on the next lookup; retain only successful probes.
    loginShellEnvProbeCache.set(cacheKey, [...shellEnv.entries()]);
    return { ok: true, shellEnv };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

type ShellEnvFallbackResult =
  | { ok: true; applied: string[]; skippedReason?: never }
  | { ok: true; applied: []; skippedReason: "already-has-keys" | "disabled" }
  | { ok: false; error: string; applied: [] };

type ShellEnvFallbackOptions = Parameters<typeof getShellPathFromLoginShell>[0] & {
  enabled: boolean;
  expectedKeys: string[];
  logger?: Pick<typeof console, "warn">;
};

export function loadShellEnvFallback(opts: ShellEnvFallbackOptions): ShellEnvFallbackResult {
  const logger = opts.logger ?? console;

  if (!opts.enabled) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "disabled" };
  }

  const missingExpectedKeys = opts.expectedKeys.filter((key) => !Object.hasOwn(opts.env, key));
  if (missingExpectedKeys.length === 0) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "already-has-keys" };
  }

  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform: opts.platform,
    purpose: "environment-import",
  });
  if (!probe.ok) {
    logger.warn(`[openclaw] shell env fallback failed: ${probe.error}`);
    lastAppliedKeys = [];
    return { ok: false, error: probe.error, applied: [] };
  }

  const applied: string[] = [];
  for (const key of missingExpectedKeys) {
    const value = probe.shellEnv.get(key);
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
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  return resolveTimeoutMs(parsed);
}

export function getShellPathFromLoginShell(opts: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
  platform?: NodeJS.Platform;
}): string | null {
  if (cachedShellPath !== undefined) {
    return cachedShellPath;
  }
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform,
    purpose: "path",
  });
  if (!probe.ok) {
    return null;
  }

  const shellPath = probe.shellEnv.get("PATH")?.trim();
  cachedShellPath = shellPath || null;
  return cachedShellPath;
}

/** Prepare the synchronous executable resolvers without blocking their async caller. */
export function prepareShellPathFromLoginShell(
  opts: Omit<Parameters<typeof getShellPathFromLoginShell>[0], "exec">,
): Promise<string | null> {
  if (cachedShellPath !== undefined) {
    return Promise.resolve(cachedShellPath);
  }
  if ((opts.platform ?? process.platform) === "win32") {
    cachedShellPath = null;
    return Promise.resolve(null);
  }
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const shell = resolveShell(opts.env);
  const execEnv = resolveShellExecEnv(opts.env);
  const cacheKey = createLoginShellEnvCacheKey({
    shell,
    timeoutMs,
    execEnv,
    purpose: "path",
  });
  const pending = pendingShellPathProbes.get(cacheKey);
  if (pending) {
    return pending;
  }
  const cached = loginShellEnvProbeCache.peek(cacheKey);
  const probe = cached
    ? Promise.resolve(new Map(cached))
    : execLoginShellEnvZeroAsync({ shell, env: execEnv, timeoutMs, purpose: "path" }).then(
        parseShellEnv,
      );
  const result = probe
    .then((shellEnv) => {
      loginShellEnvProbeCache.set(cacheKey, [...shellEnv.entries()]);
      // A synchronous cold caller may have completed while this probe was in flight.
      if (cachedShellPath === undefined) {
        cachedShellPath = shellEnv.get("PATH")?.trim() || null;
      }
      return cachedShellPath;
    })
    .catch(() => cachedShellPath ?? null)
    .finally(() => pendingShellPathProbes.delete(cacheKey));
  pendingShellPathProbes.set(cacheKey, result);
  return result;
}

type UserShellExecutableResolution = {
  executable: string;
  /** Present only when the login-shell PATH selected the executable. */
  pathEnv?: string;
};

export function resolveExecutableFromUserShellPath(
  executable: string,
  opts: Parameters<typeof getShellPathFromLoginShell>[0] & {
    pathEnv?: string;
    includeExtensionless?: boolean;
    strategy: "fallback" | "prefer";
  },
): UserShellExecutableResolution | undefined {
  const direct = resolveExecutableFromPathEnv(
    executable,
    opts.pathEnv ?? opts.env.PATH ?? opts.env.Path ?? "",
    opts.env,
    { includeExtensionless: opts.includeExtensionless },
  );
  if (direct && opts.strategy === "fallback") {
    return { executable: direct };
  }
  const shellPath = getShellPathFromLoginShell({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform: opts.platform,
  });
  if (!shellPath) {
    return direct ? { executable: direct } : undefined;
  }
  const resolved = resolveExecutableFromPathEnv(executable, shellPath, opts.env, {
    includeExtensionless: opts.includeExtensionless,
  });
  if (resolved) {
    return { executable: resolved, pathEnv: shellPath };
  }
  return direct ? { executable: direct } : undefined;
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedKeys];
}

export function clearShellEnvAppliedKeys(keys: readonly string[]): void {
  const removed = new Set(keys);
  lastAppliedKeys = lastAppliedKeys.filter((key) => !removed.has(key));
}
