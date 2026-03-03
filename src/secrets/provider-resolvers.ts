import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExecSecretProviderConfig,
  FileSecretProviderConfig,
  SecretProviderConfig,
  SecretRef,
} from "../config/types.secrets.js";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { isPathInside } from "../security/scan-paths.js";
import { resolveUserPath } from "../utils.js";
import { readJsonPointer } from "./json-pointer.js";
import { SINGLE_VALUE_FILE_REF_ID } from "./ref-contract.js";
import { isNonEmptyString, isRecord, normalizePositiveInt } from "./shared.js";

const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

export type SecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  filePayloadByProvider?: Map<string, Promise<unknown>>;
};

export type ResolutionLimits = {
  maxProviderConcurrency: number;
  maxRefsPerProvider: number;
  maxBatchBytes: number;
};

export type ProviderResolutionOutput = Map<string, unknown>;

function isAbsolutePathname(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

async function assertSecurePath(params: {
  targetPath: string;
  label: string;
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowReadableByOthers?: boolean;
  allowSymlinkPath?: boolean;
}): Promise<string> {
  if (!isAbsolutePathname(params.targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  let effectivePath = params.targetPath;
  let stat = await safeStat(effectivePath);
  if (!stat.ok) {
    throw new Error(`${params.label} is not readable: ${effectivePath}`);
  }
  if (stat.isDir) {
    throw new Error(`${params.label} must be a file: ${effectivePath}`);
  }
  if (stat.isSymlink) {
    if (!params.allowSymlinkPath) {
      throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
    }
    try {
      effectivePath = await fs.realpath(effectivePath);
    } catch {
      throw new Error(`${params.label} symlink target is not readable: ${params.targetPath}`);
    }
    if (!isAbsolutePathname(effectivePath)) {
      throw new Error(`${params.label} resolved symlink target must be an absolute path.`);
    }
    stat = await safeStat(effectivePath);
    if (!stat.ok) {
      throw new Error(`${params.label} is not readable: ${effectivePath}`);
    }
    if (stat.isDir) {
      throw new Error(`${params.label} must be a file: ${effectivePath}`);
    }
    if (stat.isSymlink) {
      throw new Error(`${params.label} symlink target must not be a symlink: ${effectivePath}`);
    }
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }
  if (params.allowInsecurePath) {
    return effectivePath;
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  const writableByOthers = perms.worldWritable || perms.groupWritable;
  const readableByOthers = perms.worldReadable || perms.groupReadable;
  if (writableByOthers || (!params.allowReadableByOthers && readableByOthers)) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }

  if (process.platform === "win32" && perms.source === "unknown") {
    throw new Error(
      `${params.label} ACL verification unavailable on Windows for ${effectivePath}.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}

async function readFileProviderPayload(params: {
  providerName: string;
  providerConfig: FileSecretProviderConfig;
  cache?: SecretRefResolveCache;
}): Promise<unknown> {
  const cacheKey = params.providerName;
  const cache = params.cache;
  if (cache?.filePayloadByProvider?.has(cacheKey)) {
    return await (cache.filePayloadByProvider.get(cacheKey) as Promise<unknown>);
  }

  const filePath = resolveUserPath(params.providerConfig.path);
  const readPromise = (async () => {
    const secureFilePath = await assertSecurePath({
      targetPath: filePath,
      label: `secrets.providers.${params.providerName}.path`,
    });
    const timeoutMs = normalizePositiveInt(
      params.providerConfig.timeoutMs,
      DEFAULT_FILE_TIMEOUT_MS,
    );
    const maxBytes = normalizePositiveInt(params.providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
    const abortController = new AbortController();
    const timeoutErrorMessage = `File provider "${params.providerName}" timed out after ${timeoutMs}ms.`;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new Error(timeoutErrorMessage));
      }, timeoutMs);
    });
    try {
      const payload = await Promise.race([
        fs.readFile(secureFilePath, { signal: abortController.signal }),
        timeoutPromise,
      ]);
      if (payload.byteLength > maxBytes) {
        throw new Error(`File provider "${params.providerName}" exceeded maxBytes (${maxBytes}).`);
      }
      const text = payload.toString("utf8");
      if (params.providerConfig.mode === "singleValue") {
        return text.replace(/\r?\n$/, "");
      }
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) {
        throw new Error(`File provider "${params.providerName}" payload is not a JSON object.`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(timeoutErrorMessage, { cause: error });
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  })();

  if (cache) {
    cache.filePayloadByProvider ??= new Map();
    cache.filePayloadByProvider.set(cacheKey, readPromise);
  }
  return await readPromise;
}

async function resolveEnvRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: Extract<SecretProviderConfig, { source: "env" }>;
  env: NodeJS.ProcessEnv;
}): Promise<ProviderResolutionOutput> {
  const resolved = new Map<string, unknown>();
  const allowlist = params.providerConfig.allowlist
    ? new Set(params.providerConfig.allowlist)
    : null;
  for (const ref of params.refs) {
    if (allowlist && !allowlist.has(ref.id)) {
      throw new Error(
        `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${params.providerName}.allowlist.`,
      );
    }
    const envValue = params.env[ref.id] ?? process.env[ref.id];
    if (!isNonEmptyString(envValue)) {
      throw new Error(`Environment variable "${ref.id}" is missing or empty.`);
    }
    resolved.set(ref.id, envValue);
  }
  return resolved;
}

async function resolveFileRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: FileSecretProviderConfig;
  cache?: SecretRefResolveCache;
}): Promise<ProviderResolutionOutput> {
  const payload = await readFileProviderPayload({
    providerName: params.providerName,
    providerConfig: params.providerConfig,
    cache: params.cache,
  });
  const mode = params.providerConfig.mode ?? "json";
  const resolved = new Map<string, unknown>();
  if (mode === "singleValue") {
    for (const ref of params.refs) {
      if (ref.id !== SINGLE_VALUE_FILE_REF_ID) {
        throw new Error(
          `singleValue file provider "${params.providerName}" expects ref id "${SINGLE_VALUE_FILE_REF_ID}".`,
        );
      }
      resolved.set(ref.id, payload);
    }
    return resolved;
  }
  for (const ref of params.refs) {
    resolved.set(ref.id, readJsonPointer(payload, ref.id, { onMissing: "throw" }));
  }
  return resolved;
}

type ExecRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "timeout" | "no-output-timeout";
};

function isIgnorableStdinWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String(error.code);
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

async function runExecResolver(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  maxOutputBytes: number;
}): Promise<ExecRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let noOutputTimedOut = false;
    let outputBytes = 0;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, params.timeoutMs);

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
        noOutputTimer = null;
      }
    };

    const armNoOutputTimer = () => {
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        noOutputTimedOut = true;
        child.kill("SIGKILL");
      }, params.noOutputTimeoutMs);
    };

    const append = (chunk: Buffer | string, target: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > params.maxOutputBytes) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimers();
          reject(
            new Error(`Exec provider output exceeded maxOutputBytes (${params.maxOutputBytes}).`),
          );
        }
        return;
      }
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      armNoOutputTimer();
    };

    armNoOutputTimer();
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    });
    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({
        stdout,
        stderr,
        code,
        signal,
        termination: noOutputTimedOut ? "no-output-timeout" : timedOut ? "timeout" : "exit",
      });
    });

    const handleStdinError = (error: unknown) => {
      if (isIgnorableStdinWriteError(error) || settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdin?.on("error", handleStdinError);
    try {
      child.stdin?.end(params.input);
    } catch (error) {
      handleStdinError(error);
    }
  });
}

function parseExecValues(params: {
  providerName: string;
  ids: string[];
  stdout: string;
  jsonOnly: boolean;
}): Record<string, unknown> {
  const trimmed = params.stdout.trim();
  if (!trimmed) {
    throw new Error(`Exec provider "${params.providerName}" returned empty stdout.`);
  }

  let parsed: unknown;
  if (!params.jsonOnly && params.ids.length === 1) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { [params.ids[0]]: trimmed };
    }
  } else {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error(`Exec provider "${params.providerName}" returned invalid JSON.`);
    }
  }

  if (!isRecord(parsed)) {
    if (!params.jsonOnly && params.ids.length === 1 && typeof parsed === "string") {
      return { [params.ids[0]]: parsed };
    }
    throw new Error(`Exec provider "${params.providerName}" response must be an object.`);
  }
  if (parsed.protocolVersion !== 1) {
    throw new Error(`Exec provider "${params.providerName}" protocolVersion must be 1.`);
  }
  const responseValues = parsed.values;
  if (!isRecord(responseValues)) {
    throw new Error(`Exec provider "${params.providerName}" response missing "values".`);
  }
  const responseErrors = isRecord(parsed.errors) ? parsed.errors : null;
  const out: Record<string, unknown> = {};
  for (const id of params.ids) {
    if (responseErrors && id in responseErrors) {
      const entry = responseErrors[id];
      if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim()) {
        throw new Error(
          `Exec provider "${params.providerName}" failed for id "${id}" (${entry.message.trim()}).`,
        );
      }
      throw new Error(`Exec provider "${params.providerName}" failed for id "${id}".`);
    }
    if (!(id in responseValues)) {
      throw new Error(`Exec provider "${params.providerName}" response missing id "${id}".`);
    }
    out[id] = responseValues[id];
  }
  return out;
}

async function resolveExecRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: ExecSecretProviderConfig;
  env: NodeJS.ProcessEnv;
  limits: ResolutionLimits;
}): Promise<ProviderResolutionOutput> {
  const ids = [...new Set(params.refs.map((ref) => ref.id))];
  if (ids.length > params.limits.maxRefsPerProvider) {
    throw new Error(
      `Exec provider "${params.providerName}" exceeded maxRefsPerProvider (${params.limits.maxRefsPerProvider}).`,
    );
  }

  const commandPath = resolveUserPath(params.providerConfig.command);
  const secureCommandPath = await assertSecurePath({
    targetPath: commandPath,
    label: `secrets.providers.${params.providerName}.command`,
    trustedDirs: params.providerConfig.trustedDirs,
    allowInsecurePath: params.providerConfig.allowInsecurePath,
    allowReadableByOthers: true,
    allowSymlinkPath: params.providerConfig.allowSymlinkCommand,
  });

  const requestPayload = {
    protocolVersion: 1,
    provider: params.providerName,
    ids,
  };
  const input = JSON.stringify(requestPayload);
  if (Buffer.byteLength(input, "utf8") > params.limits.maxBatchBytes) {
    throw new Error(
      `Exec provider "${params.providerName}" request exceeded maxBatchBytes (${params.limits.maxBatchBytes}).`,
    );
  }

  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of params.providerConfig.passEnv ?? []) {
    const value = params.env[key] ?? process.env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(params.providerConfig.env ?? {})) {
    childEnv[key] = value;
  }

  const timeoutMs = normalizePositiveInt(params.providerConfig.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
  const noOutputTimeoutMs = normalizePositiveInt(
    params.providerConfig.noOutputTimeoutMs,
    timeoutMs,
  );
  const maxOutputBytes = normalizePositiveInt(
    params.providerConfig.maxOutputBytes,
    DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  );
  const jsonOnly = params.providerConfig.jsonOnly ?? true;

  const result = await runExecResolver({
    command: secureCommandPath,
    args: params.providerConfig.args ?? [],
    cwd: path.dirname(secureCommandPath),
    env: childEnv,
    input,
    timeoutMs,
    noOutputTimeoutMs,
    maxOutputBytes,
  });
  if (result.termination === "timeout") {
    throw new Error(`Exec provider "${params.providerName}" timed out after ${timeoutMs}ms.`);
  }
  if (result.termination === "no-output-timeout") {
    throw new Error(
      `Exec provider "${params.providerName}" produced no output for ${noOutputTimeoutMs}ms.`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `Exec provider "${params.providerName}" exited with code ${String(result.code)}.`,
    );
  }

  const values = parseExecValues({
    providerName: params.providerName,
    ids,
    stdout: result.stdout,
    jsonOnly,
  });
  const resolved = new Map<string, unknown>();
  for (const id of ids) {
    resolved.set(id, values[id]);
  }
  return resolved;
}

export async function resolveProviderRefs(params: {
  refs: SecretRef[];
  providerName: string;
  providerConfig: SecretProviderConfig;
  env: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
  limits: ResolutionLimits;
}): Promise<ProviderResolutionOutput> {
  if (params.providerConfig.source === "env") {
    return await resolveEnvRefs({
      refs: params.refs,
      providerName: params.providerName,
      providerConfig: params.providerConfig,
      env: params.env,
    });
  }
  if (params.providerConfig.source === "file") {
    return await resolveFileRefs({
      refs: params.refs,
      providerName: params.providerName,
      providerConfig: params.providerConfig,
      cache: params.cache,
    });
  }
  if (params.providerConfig.source === "exec") {
    return await resolveExecRefs({
      refs: params.refs,
      providerName: params.providerName,
      providerConfig: params.providerConfig,
      env: params.env,
      limits: params.limits,
    });
  }
  throw new Error(
    `Unsupported secret provider source "${String((params.providerConfig as { source?: unknown }).source)}".`,
  );
}
