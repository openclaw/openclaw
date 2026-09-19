/** LaunchAgent plist, environment-file, and atomic publication ownership. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import { resolveGatewayServiceDescription } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  buildLaunchAgentPlist,
  quoteLaunchAgentEnvironmentValue,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { assertNoSystemLaunchDaemonOwnership } from "./launchd-system.js";
import { formatLine, normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir, resolveGatewayStateDir } from "./paths.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import { publishServiceFile } from "./service-stage.js";
import type { GatewayServiceEnv, GatewayServiceInstallArgs } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const LAUNCH_AGENT_DIR_MODE = 0o755;
// launchd rejects user LaunchAgent plists without group/other read access on
// current macOS. Secrets stay in the separate 0600 environment file.
const LAUNCH_AGENT_PLIST_MODE = 0o644;
const LAUNCH_AGENT_PRIVATE_DIR_MODE = 0o700;
export const LAUNCH_AGENT_ENV_FILE_MODE = 0o600;
export const LAUNCH_AGENT_ENV_WRAPPER_MODE = 0o700;
const LAUNCH_AGENT_ENV_DIR_NAME = "service-env";
export function resolveLaunchAgentPlistPathForLabel(
  env: Record<string, string | undefined>,
  label: string,
): string {
  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

function resolveLaunchAgentEnvDir(env: GatewayServiceEnv): string {
  return path.join(resolveGatewayStateDir(env), LAUNCH_AGENT_ENV_DIR_NAME);
}

export function resolveLaunchAgentEnvFilePath(env: GatewayServiceEnv, label: string): string {
  return path.join(resolveLaunchAgentEnvDir(env), `${label}.env`);
}

export function resolveLaunchAgentEnvWrapperPath(env: GatewayServiceEnv, label: string): string {
  return path.join(resolveLaunchAgentEnvDir(env), `${label}-env-wrapper.sh`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Matches one generated `export KEY='value'` line. The generated file is
// line-oriented, so unknown lines pass through byte-for-byte.
const GENERATED_ENV_EXPORT_LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/;

function decodeShellSingleQuoted(value: string): string {
  return value.replaceAll("'\\''", "'");
}

// A value whose bytes begin and end with a literal double quote — the shape
// #103804 corruption left inside the shell quotes (export AWS_REGION='"x"').
function hasWrappingJsonQuotePair(value: string): boolean {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"');
}

function scanGeneratedEnvFileJsonQuotes(content: string): {
  healedContent: string;
  keys: string[];
} {
  const keys: string[] = [];
  const healedLines = content.split("\n").map((line) => {
    const match = GENERATED_ENV_EXPORT_LINE.exec(line);
    if (!match) {
      return line;
    }
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) {
      return line;
    }
    const value = decodeShellSingleQuoted(rawValue);
    if (!hasWrappingJsonQuotePair(value)) {
      return line;
    }
    keys.push(key);
    return `export ${key}=${shellSingleQuote(value.slice(1, -1))}`;
  });
  return { healedContent: healedLines.join("\n"), keys };
}

async function readLaunchAgentEnvFileContent(
  env: GatewayServiceEnv,
  label: string,
): Promise<{ envFilePath: string; content: string } | null> {
  const envFilePath = resolveLaunchAgentEnvFilePath(env, label);
  try {
    return { envFilePath, content: await fs.readFile(envFilePath, "utf8") };
  } catch {
    return null;
  }
}

/** Reports keys in a generated env file still carrying #103804 quote corruption. */
export async function detectLaunchAgentEnvFileJsonQuoteKeys(
  env: GatewayServiceEnv,
  label: string,
): Promise<{ envFilePath: string; keys: string[] } | null> {
  const file = await readLaunchAgentEnvFileContent(env, label);
  if (!file) {
    return null;
  }
  const { keys } = scanGeneratedEnvFileJsonQuotes(file.content);
  return keys.length > 0 ? { envFilePath: file.envFilePath, keys } : null;
}

/**
 * One-time doctor repair for #103804: rewrites generated env file entries
 * whose values carry a wrapping JSON quote pair inside the shell quotes.
 * Detection is shape-based on purpose so legacy files written before the
 * managed-keys metadata existed heal too; callers gate the rewrite on the
 * doctor repair prompt, and the runtime reader stays lossless.
 */
export async function repairLaunchAgentEnvFileJsonQuotes(
  env: GatewayServiceEnv,
  label: string,
): Promise<{ envFilePath: string; healedKeys: string[] } | null> {
  const file = await readLaunchAgentEnvFileContent(env, label);
  if (!file) {
    return null;
  }
  const { healedContent, keys } = scanGeneratedEnvFileJsonQuotes(file.content);
  if (keys.length === 0) {
    return null;
  }
  // This file carries live service credentials: keep a recovery copy and
  // publish atomically so an interrupted write can never leave the next
  // service start without its complete environment (temp + rename, matching
  // the plist publication above). The recovery copy survives on failure.
  const recoveryPath = `${file.envFilePath}.openclaw-repair-backup`;
  try {
    await fs.writeFile(recoveryPath, file.content, {
      encoding: "utf8",
      mode: LAUNCH_AGENT_ENV_FILE_MODE,
    });
  } catch (error) {
    throw new Error(
      `service env repair aborted before any change (recovery copy failed): ${String(error)}`,
      { cause: error },
    );
  }
  const temporaryPath = `${file.envFilePath}.openclaw-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, healedContent, {
      encoding: "utf8",
      flag: "wx",
      mode: LAUNCH_AGENT_ENV_FILE_MODE,
    });
    await fs.rename(temporaryPath, file.envFilePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(
      `service env repair failed before publishing; original preserved at ${recoveryPath}: ${String(error)}`,
      { cause: error },
    );
  }
  await fs.rm(recoveryPath, { force: true }).catch(() => {});
  return { envFilePath: file.envFilePath, healedKeys: keys };
}

function collectLaunchAgentEnvironmentEntries(
  environment: GatewayServiceEnv | undefined,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(environment ?? {})) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    const value = rawValue?.trim();
    // Empty NODE_OPTIONS intentionally clears launchd's inherited Node flags.
    if (!key || value === undefined || (!value && key !== "NODE_OPTIONS")) {
      continue;
    }
    entries.push([key, value]);
  }
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

function buildLaunchAgentEnvironmentFile(entries: Array<[string, string]>): string {
  return [
    "# Generated by OpenClaw. Do not edit while the gateway service is installed.",
    ...entries.map(([key, value]) => `export ${key}=${quoteLaunchAgentEnvironmentValue(value)}`),
    "",
  ].join("\n");
}

export function buildLaunchAgentEnvironmentWrapper(): string {
  return `#!/bin/sh
set -eu
env_file="$1"
shift
if [ -f "$env_file" ]; then
  . "$env_file"
fi
exec "$@"
`;
}

async function resolveLaunchAgentEnvironmentWrapperOverwriteWarnings(params: {
  wrapperPath: string;
  generatedWrapper: string;
}): Promise<string[]> {
  const existingWrapper = await fs.readFile(params.wrapperPath, "utf8").catch(() => null);
  if (existingWrapper === null || existingWrapper === params.generatedWrapper) {
    return [];
  }
  return [
    `Existing generated LaunchAgent env wrapper at ${params.wrapperPath} contains custom behavior and will be overwritten; move custom behavior to openclaw gateway install --wrapper <path> or OPENCLAW_WRAPPER.`,
  ];
}

function writeLaunchAgentOverwriteWarnings(
  stdout: NodeJS.WritableStream | undefined,
  warn: ((message: string) => void) | undefined,
  warnings: readonly string[],
): void {
  for (const warning of warnings) {
    if (warn) {
      warn(warning);
      continue;
    }
    if (!stdout) {
      continue;
    }
    stdout.write(`${formatLine("Warning", warning)}\n`);
  }
}

function isLaunchAgentEnvironmentWrapperArgs(params: {
  programArguments: string[];
  envFilePath: string;
  wrapperPath: string;
}): boolean {
  return (
    (params.programArguments[0] === params.wrapperPath &&
      params.programArguments[1] === params.envFilePath) ||
    (params.programArguments[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL &&
      params.programArguments[1] === params.wrapperPath &&
      params.programArguments[2] === params.envFilePath)
  );
}

async function prepareLaunchAgentProgramArguments(params: {
  env: GatewayServiceEnv;
  label: string;
  programArguments: string[];
  environment: GatewayServiceEnv | undefined;
  stdout?: NodeJS.WritableStream;
  warn?: (message: string) => void;
  definitionTransaction?: GatewayServiceInstallArgs["definitionTransaction"];
}): Promise<{
  programArguments: string[];
  inlineEnvironment?: GatewayServiceEnv;
}> {
  const entries = collectLaunchAgentEnvironmentEntries(params.environment);
  if (entries.length === 0) {
    return { programArguments: params.programArguments };
  }

  // Environment values with secrets live in an owner-only env file instead of
  // inline plist XML, which can be harder to rotate and audit.
  const envDir = resolveLaunchAgentEnvDir(params.env);
  const envFilePath = resolveLaunchAgentEnvFilePath(params.env, params.label);
  const wrapperPath = resolveLaunchAgentEnvWrapperPath(params.env, params.label);
  const generatedWrapper = buildLaunchAgentEnvironmentWrapper();
  await ensureSecureDirectory(envDir, LAUNCH_AGENT_PRIVATE_DIR_MODE);
  const environmentFile = buildLaunchAgentEnvironmentFile(entries);
  await publishServiceFile({
    filePath: envFilePath,
    contents: environmentFile,
    mode: LAUNCH_AGENT_ENV_FILE_MODE,
    definitionTransaction: params.definitionTransaction,
  });
  const overwriteWarnings = await resolveLaunchAgentEnvironmentWrapperOverwriteWarnings({
    wrapperPath,
    generatedWrapper,
  });
  writeLaunchAgentOverwriteWarnings(params.stdout, params.warn, overwriteWarnings);
  await publishServiceFile({
    filePath: wrapperPath,
    contents: generatedWrapper,
    mode: LAUNCH_AGENT_ENV_WRAPPER_MODE,
    definitionTransaction: params.definitionTransaction,
  });

  if (
    isLaunchAgentEnvironmentWrapperArgs({
      programArguments: params.programArguments,
      envFilePath,
      wrapperPath,
    })
  ) {
    return { programArguments: params.programArguments };
  }

  return {
    programArguments: [
      LAUNCH_AGENT_ENV_WRAPPER_SHELL,
      wrapperPath,
      envFilePath,
      ...params.programArguments,
    ],
  };
}

export function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string {
  const label = resolveLaunchAgentLabel(env);
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

export function resolveLaunchAgentEnvironmentReadOptions(env: GatewayServiceEnv, label: string) {
  return {
    expectedEnvironmentWrapperPath: resolveLaunchAgentEnvWrapperPath(env, label),
    expectedEnvironmentFilePath: resolveLaunchAgentEnvFilePath(env, label),
    generatedEnvironmentLabel: label,
  };
}

async function ensureLaunchAgentPlistReadable(plistPath: string): Promise<void> {
  assertGatewayServiceUpdateCurrent();
  await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => undefined);
}

export type LaunchAgentFileSnapshot = { contents: Buffer; mode: number };

export async function readExistingLaunchAgentPlist(
  plistPath: string,
): Promise<LaunchAgentFileSnapshot | null> {
  try {
    const handle = await fs.open(plistPath, "r");
    try {
      const contents = await handle.readFile();
      const metadata = await handle.stat();
      return { contents, mode: metadata.mode & 0o7777 };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function publishLaunchAgentPlist(params: {
  label: string;
  plistPath: string;
  contents: string | Uint8Array;
  mode?: number;
  definitionTransaction?: GatewayServiceInstallArgs["definitionTransaction"];
}): Promise<void> {
  const previous = await readExistingLaunchAgentPlist(params.plistPath);
  await publishServiceFile({
    filePath: params.plistPath,
    contents: params.contents,
    mode: params.mode ?? LAUNCH_AGENT_PLIST_MODE,
    definitionTransaction: params.definitionTransaction,
    beforeRename: () => assertNoSystemLaunchDaemonOwnership(params.label),
  });
  try {
    await assertNoSystemLaunchDaemonOwnership(params.label);
  } catch (ownershipError) {
    // The transaction owns compensation and rejects later operator edits.
    if (params.definitionTransaction) {
      throw ownershipError;
    }
    try {
      if (previous === null) {
        assertGatewayServiceUpdateCurrent();
        await fs.unlink(params.plistPath);
      } else {
        await publishServiceFile({
          filePath: params.plistPath,
          contents: previous.contents,
          mode: previous.mode,
        });
      }
    } catch (rollbackError) {
      const ownershipDetail =
        ownershipError instanceof Error ? ownershipError.message : String(ownershipError);
      throw new Error(
        `${ownershipDetail}\nThe previous LaunchAgent plist at ${params.plistPath} could not be restored.`,
        { cause: rollbackError },
      );
    }
    throw ownershipError;
  }
}

async function ensureSecureDirectory(
  targetPath: string,
  dirMode = LAUNCH_AGENT_DIR_MODE,
): Promise<void> {
  assertGatewayServiceUpdateCurrent();
  await fs.mkdir(targetPath, { recursive: true, mode: dirMode });
  try {
    const stat = await fs.stat(targetPath);
    const mode = stat.mode & 0o777;
    const forbiddenMode = dirMode === LAUNCH_AGENT_PRIVATE_DIR_MODE ? 0o077 : 0o022;
    const tightenedMode = mode & ~forbiddenMode;
    if (tightenedMode !== mode) {
      assertGatewayServiceUpdateCurrent();
      await fs.chmod(targetPath, tightenedMode);
    }
  } catch {
    // Best effort: keep install working even if chmod/stat is unavailable.
  }
}

async function ensureLaunchAgentEnvironmentDirectories(
  environment: Record<string, string | undefined> | undefined,
): Promise<void> {
  const tmpDir = environment?.TMPDIR?.trim();
  if (tmpDir) {
    await ensureSecureDirectory(tmpDir, LAUNCH_AGENT_PRIVATE_DIR_MODE);
  }
}

export async function writeLaunchAgentPlist({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
  stdout,
  warn,
  definitionTransaction,
}: GatewayServiceInstallArgs): Promise<{ plistPath: string; stdoutPath: string }> {
  const label = resolveLaunchAgentLabel(env);
  await assertNoSystemLaunchDaemonOwnership(label);

  const { logDir, stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  await ensureSecureDirectory(logDir);

  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  const libraryDir = path.posix.join(home, "Library");
  await ensureSecureDirectory(home);
  await ensureSecureDirectory(libraryDir);
  await ensureSecureDirectory(path.dirname(plistPath));
  await ensureLaunchAgentEnvironmentDirectories(environment);
  const prepared = await prepareLaunchAgentProgramArguments({
    env,
    label,
    programArguments,
    environment,
    stdout,
    warn,
    definitionTransaction,
  });

  const serviceDescription = resolveGatewayServiceDescription({ env, description });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments: prepared.programArguments,
    workingDirectory,
    stdoutPath,
    // Both handles target one file: launchd cannot merge streams, and darwin
    // diagnostics reads only stdout (readLastGatewayErrorLine).
    stderrPath: stdoutPath,
    environment: prepared.inlineEnvironment,
  });
  await publishLaunchAgentPlist({ label, plistPath, contents: plist, definitionTransaction });
  return { plistPath, stdoutPath };
}
export async function rewriteLaunchAgentPlistForRestart({
  env,
  label,
  plistPath,
  stdout,
  warn,
}: {
  env: GatewayServiceEnv;
  label: string;
  plistPath: string;
  stdout?: NodeJS.WritableStream;
  warn?: (message: string) => void;
}): Promise<boolean> {
  const existing = await readLaunchAgentProgramArgumentsFromFile(
    plistPath,
    resolveLaunchAgentEnvironmentReadOptions(env, label),
  );
  if (!existing?.programArguments.length) {
    return false;
  }

  const { logDir, stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  await ensureSecureDirectory(logDir);

  const serviceDescription = resolveGatewayServiceDescription({
    env,
  });
  // Restart rewrites must retire install provenance from legacy plists instead
  // of copying it into the next canonical definition.
  const canonicalEnvironment = {
    ...existing.environment,
    OPENCLAW_SERVICE_VERSION: undefined,
  };
  const prepared = await prepareLaunchAgentProgramArguments({
    env,
    label,
    programArguments: existing.programArguments,
    environment: canonicalEnvironment,
    stdout,
    warn,
  });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments: prepared.programArguments,
    workingDirectory: existing.workingDirectory,
    stdoutPath,
    // Both handles target one file: launchd cannot merge streams, and darwin
    // diagnostics reads only stdout (readLastGatewayErrorLine).
    stderrPath: stdoutPath,
    environment: prepared.inlineEnvironment,
  });
  const previousPlist = await fs.readFile(plistPath, "utf8").catch(() => "");
  if (previousPlist === plist) {
    await ensureLaunchAgentPlistReadable(plistPath);
    return false;
  }
  await publishLaunchAgentPlist({ label, plistPath, contents: plist });
  return true;
}
