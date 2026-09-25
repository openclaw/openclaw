// Resolves Windows system and Program Files install roots.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";
const WINDOWS_NT_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const WINDOWS_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";
const REG_QUERY_TIMEOUT_MS = 5_000;

type WindowsInstallRoots = {
  systemRoot: string;
  programFiles: string;
  programFilesX86: string;
  programW6432: string | null;
};

type WindowsProcessRoots = {
  env: Record<string, string | undefined>;
  systemRoot: string;
  installRoots?: WindowsInstallRoots;
};

let cachedProcessRoots: WindowsProcessRoots | null = null;

function locateWindowsRegExe(): string | null {
  const filePath = path.win32.join(DEFAULT_WINDOWS_SYSTEM_ROOT, "System32", "reg.exe");
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return filePath;
  } catch {
    return null;
  }
}

function trimTrailingSeparators(value: string): string {
  const parsed = path.win32.parse(value);
  let trimmed = value;
  while (trimmed.length > parsed.root.length && /[\\/]/.test(trimmed.at(-1) ?? "")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Windows install roots should be local absolute directories, not drive-relative
 * paths, UNC shares, or PATH-like lists that could widen trust unexpectedly.
 */
function normalizeWindowsInstallRoot(raw: string | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes(";")
  ) {
    return null;
  }
  const normalized = trimTrailingSeparators(path.win32.normalize(trimmed));
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
    return null;
  }
  if (normalized.length <= parsed.root.length) {
    return null;
  }
  return normalized;
}

function getEnvValueCaseInsensitive(
  env: Record<string, string | undefined>,
  expectedKey: string,
): string | undefined {
  const direct = env[expectedKey];
  if (direct !== undefined) {
    return direct;
  }
  const upper = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === upper);
  return actualKey ? env[actualKey] : undefined;
}

function parseRegQueryValue(stdout: string, valueName: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_[A-Z0-9_]+\\s+(.+)$`, "im");
  const match = stdout.match(pattern);
  return match?.[1]?.trim() || null;
}

function runRegQuery(
  regExe: string,
  key: string,
  valueName: string,
  use64BitView: boolean,
  timeoutMs: number,
): string {
  const args = ["query", key, "/v", valueName];
  if (use64BitView) {
    args.push("/reg:64");
  }
  return execFileSync(regExe, args, {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

/** Queries one Windows registry string value via reg.exe; null when absent or unreadable. */
export function queryWindowsRegistryValue(
  key: string,
  valueName: string,
  deadlineMs?: number,
): string | null {
  const regExe = locateWindowsRegExe();
  if (!regExe) {
    return null;
  }

  for (const use64BitView of [true, false]) {
    const timeoutMs =
      deadlineMs === undefined
        ? REG_QUERY_TIMEOUT_MS
        : Math.min(REG_QUERY_TIMEOUT_MS, Math.ceil(deadlineMs - performance.now()));
    if (timeoutMs <= 0) {
      return null;
    }
    try {
      const stdout = runRegQuery(regExe, key, valueName, use64BitView, timeoutMs);
      const parsed = parseRegQueryValue(stdout, valueName);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Keep trying alternate registry views or fallbacks below.
    }
  }
  return null;
}

function getRegistryProgramFilesRoots(): Partial<WindowsInstallRoots> {
  return {
    programFiles:
      normalizeWindowsInstallRoot(
        queryWindowsRegistryValue(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir") ?? undefined,
      ) ?? undefined,
    programFilesX86:
      normalizeWindowsInstallRoot(
        queryWindowsRegistryValue(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir (x86)") ??
          undefined,
      ) ?? undefined,
    programW6432:
      normalizeWindowsInstallRoot(
        queryWindowsRegistryValue(WINDOWS_CURRENT_VERSION_KEY, "ProgramW6432Dir") ?? undefined,
      ) ?? undefined,
  };
}

function buildWindowsInstallRoots(
  env: Record<string, string | undefined>,
  registryRoots: Partial<WindowsInstallRoots> = {},
): WindowsInstallRoots {
  const envProgramW6432 = normalizeWindowsInstallRoot(
    getEnvValueCaseInsensitive(env, "ProgramW6432"),
  );
  const programW6432 = registryRoots.programW6432 ?? envProgramW6432 ?? null;

  return {
    systemRoot: registryRoots.systemRoot ?? resolveSystemRootFromEnv(env),
    programFiles:
      registryRoots.programFiles ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles")) ??
      programW6432 ??
      DEFAULT_PROGRAM_FILES,
    programFilesX86:
      registryRoots.programFilesX86 ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles(x86)")) ??
      DEFAULT_PROGRAM_FILES_X86,
    programW6432,
  };
}

function resolveSystemRootFromEnv(env: Record<string, string | undefined>): string {
  return (
    normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT
  );
}

function getProcessRoots(deadlineMs?: number) {
  if (!cachedProcessRoots) {
    const env: Record<string, string | undefined> = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
    ]) {
      env[key] = getEnvValueCaseInsensitive(process.env, key);
    }
    const roots: WindowsProcessRoots = {
      env,
      systemRoot:
        normalizeWindowsInstallRoot(
          queryWindowsRegistryValue(WINDOWS_NT_CURRENT_VERSION_KEY, "SystemRoot", deadlineMs) ??
            undefined,
        ) ?? resolveSystemRootFromEnv(env),
    };
    // Do not make a budget-exhausted fallback authoritative for later reads.
    if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
      return roots;
    }
    cachedProcessRoots = roots;
  }
  return cachedProcessRoots;
}

function getWindowsSystemRoot(
  env: Record<string, string | undefined>,
  deadlineMs?: number,
): string {
  if (env !== process.env) {
    return resolveSystemRootFromEnv(env);
  }
  const roots = getProcessRoots(deadlineMs);
  return roots.installRoots?.systemRoot ?? roots.systemRoot;
}

export function getWindowsInstallRoots(
  env: Record<string, string | undefined> = process.env,
): WindowsInstallRoots {
  if (env === process.env) {
    const roots = getProcessRoots();
    // Defer Program Files registry probes, but retain the first lookup's env fallbacks.
    roots.installRoots ??= buildWindowsInstallRoots(roots.env, {
      ...getRegistryProgramFilesRoots(),
      systemRoot: roots.systemRoot,
    });
    return roots.installRoots;
  }
  return buildWindowsInstallRoots(env);
}

export function getWindowsProgramFilesRoots(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const roots = getWindowsInstallRoots(env);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [roots.programW6432, roots.programFiles, roots.programFilesX86]) {
    if (!value) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function getWindowsCmdExePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return getWindowsSystem32ExePath("cmd.exe", env);
}

export function getWindowsSystem32ExePath(
  executableName: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (
    path.win32.basename(executableName) !== executableName ||
    !/^[A-Za-z0-9_.-]+\.exe$/u.test(executableName)
  ) {
    throw new Error(`Invalid Windows System32 executable name: ${executableName}`);
  }
  return path.win32.join(getWindowsSystemRoot(env), "System32", executableName);
}

export function getWindowsPowerShellExePath(
  env: Record<string, string | undefined> = process.env,
  deadlineMs?: number,
): string {
  return path.win32.join(
    getWindowsSystemRoot(env, deadlineMs),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function getWindowsWmicExePath(
  env: Record<string, string | undefined> = process.env,
  deadlineMs?: number,
): string {
  return path.win32.join(getWindowsSystemRoot(env, deadlineMs), "System32", "wbem", "wmic.exe");
}
