import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { readStateDirDotEnvVarsFromStateDir } from "../config/state-dir-dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictInteger, parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";
import {
  buildSystemdManagedDropIn,
  buildSystemdUnit,
  OPENCLAW_MANAGED_DROPIN_FILENAME,
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  stripEnvironmentKeysFromSystemdUnit,
  stripManagedEnvFromSystemdUnit,
  updateEnvironmentFilesInSystemdUnit,
  updateExecStartInSystemdUnit,
  updateWorkingDirectoryInSystemdUnit,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";
const SYSTEMD_SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.:@-]+$/;

function validateSystemdServiceName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    path.posix.basename(name) !== name ||
    path.win32.basename(name) !== name ||
    !SYSTEMD_SERVICE_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      "OPENCLAW_SYSTEMD_UNIT must be a systemd service name, not a path or shell fragment.",
    );
  }
  return name;
}

function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(
    home,
    ".config",
    "systemd",
    "user",
    `${validateSystemdServiceName(name)}.service`,
  );
}

function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return validateSystemdServiceName(
      override.endsWith(".service") ? override.slice(0, -".service".length) : override,
    );
  }
  return validateSystemdServiceName(resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE));
}

function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

function resolveSystemdManagedDropInPath(env: GatewayServiceEnv): string {
  const unitPath = resolveSystemdUnitPath(env);
  const unitDir = path.posix.dirname(unitPath);
  const unitFile = path.posix.basename(unitPath);
  return path.posix.join(unitDir, `${unitFile}.d`, OPENCLAW_MANAGED_DROPIN_FILENAME);
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

export function resolveSystemdUserManagedDropInPath(env: GatewayServiceEnv): string {
  return resolveSystemdManagedDropInPath(env);
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

function parseSystemdUnitText(text: string): {
  execStart: string;
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  environmentFileSpecs: string[];
} {
  let execStart = "";
  let workingDirectory = "";
  const inlineEnvironment: Record<string, string> = {};
  const environmentFileSpecs: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("ExecStart=")) {
      execStart = line.slice("ExecStart=".length).trim();
    } else if (line.startsWith("WorkingDirectory=")) {
      workingDirectory = line.slice("WorkingDirectory=".length).trim();
    } else if (line.startsWith("Environment=")) {
      const raw = line.slice("Environment=".length).trim();
      for (const parsed of parseSystemdEnvAssignments(raw)) {
        inlineEnvironment[parsed.key] = parsed.value;
      }
    } else if (line.startsWith("EnvironmentFile=")) {
      const raw = line.slice("EnvironmentFile=".length).trim();
      if (raw) {
        environmentFileSpecs.push(raw);
      }
    }
  }
  return { execStart, workingDirectory, inlineEnvironment, environmentFileSpecs };
}

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const unitPath = resolveSystemdUnitPath(env);
  const dropInPath = resolveSystemdManagedDropInPath(env);
  try {
    const mainContent = await fs.readFile(unitPath, "utf8");
    const main = parseSystemdUnitText(mainContent);
    if (!main.execStart) {
      return null;
    }

    // Merge drop-in env as a separate inline source so the install-time
    // preservation pipeline sees every key the running service actually has.
    // Drop-in values override main-unit inline values by design: operators
    // depend on the managed drop-in to carry the canonical token/version
    // state across upgrades.
    const dropInContent = await readManagedDropInForMerge(dropInPath);
    const dropInParsed = dropInContent ? parseSystemdUnitText(dropInContent) : null;

    const combinedInlineEnvironment: Record<string, string> = {
      ...main.inlineEnvironment,
      ...dropInParsed?.inlineEnvironment,
    };
    const combinedEnvironmentFileSpecs: string[] = [
      ...main.environmentFileSpecs,
      ...(dropInParsed?.environmentFileSpecs ?? []),
    ];

    const environmentFromFiles = await resolveSystemdEnvironmentFiles({
      environmentFileSpecs: combinedEnvironmentFileSpecs,
      env,
      unitPath,
    });
    const mergedEnvironment = {
      ...combinedInlineEnvironment,
      ...environmentFromFiles.environment,
    };
    const mergedEnvironmentSources = {
      ...buildEnvironmentValueSources(combinedInlineEnvironment, "inline"),
      ...buildEnvironmentValueSources(environmentFromFiles.environment, "file"),
    };
    const programArguments = parseSystemdExecStart(main.execStart);
    return {
      programArguments,
      ...(main.workingDirectory ? { workingDirectory: main.workingDirectory } : {}),
      ...(Object.keys(mergedEnvironment).length > 0 ? { environment: mergedEnvironment } : {}),
      ...(Object.keys(mergedEnvironmentSources).length > 0
        ? { environmentValueSources: mergedEnvironmentSources }
        : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

function buildEnvironmentValueSources(
  environment: Record<string, string>,
  source: "inline" | "file",
): Record<string, "inline" | "file"> {
  return Object.fromEntries(Object.keys(environment).map((key) => [key, source]));
}

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  // Support the common unit-specifier used in user services.
  return input.replaceAll("%h", toPosixPath(resolveHomeDir(env)));
}

function parseEnvironmentFileSpecs(raw: string): string[] {
  return splitArgsPreservingQuotes(raw, { escapeMode: "backslash" })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvironmentFileLine(rawLine: string): { key: string; value: string } | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return null;
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmed.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  let value = trimmed.slice(eq + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

async function readSystemdEnvironmentFile(pathname: string): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(rawLine);
    if (!parsed) {
      continue;
    }
    environment[parsed.key] = parsed.value;
  }
  return environment;
}

async function resolveSystemdEnvironmentFiles(params: {
  environmentFileSpecs: string[];
  env: GatewayServiceEnv;
  unitPath: string;
}): Promise<{ environment: Record<string, string> }> {
  const resolved: Record<string, string> = {};
  if (params.environmentFileSpecs.length === 0) {
    return { environment: resolved };
  }
  const unitDir = path.posix.dirname(params.unitPath);
  for (const specRaw of params.environmentFileSpecs) {
    for (const token of parseEnvironmentFileSpecs(specRaw)) {
      const optional = token.startsWith("-");
      const pathnameRaw = optional ? token.slice(1).trim() : token;
      if (!pathnameRaw) {
        continue;
      }
      const expanded = expandSystemdSpecifier(pathnameRaw, params.env);
      const pathname = path.posix.isAbsolute(expanded)
        ? expanded
        : path.posix.resolve(unitDir, expanded);
      try {
        const fromFile = await readSystemdEnvironmentFile(pathname);
        Object.assign(resolved, fromFile);
      } catch {
        // Keep service auditing resilient even when env files are unavailable
        // in the current runtime context. Both optional and non-optional
        // EnvironmentFile entries are skipped gracefully for diagnostics.
        continue;
      }
    }
  }
  return { environment: resolved };
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = parseStrictPositiveInteger(mainPidValue);
    if (pid !== undefined) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = parseStrictInteger(execMainStatusValue);
    if (status !== undefined) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  return info;
}

async function execSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("systemctl", args);
}

function readSystemctlDetail(result: { stdout: string; stderr: string }): string {
  // Concatenate both streams so pattern matchers (isSystemdUnitNotEnabled,
  // isSystemctlMissing) can see the unit status from stdout even when
  // execFileUtf8 populates stderr with the Node error message fallback.
  return `${result.stderr} ${result.stdout}`.trim();
}

const isSystemctlMissing = isSystemctlMissingDetail;

function isSystemdUnitNotEnabled(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("disabled") ||
    normalized.includes("static") ||
    normalized.includes("indirect") ||
    normalized.includes("masked") ||
    normalized.includes("not-found") ||
    normalized.includes("could not be found") ||
    normalized.includes("failed to get unit file state")
  );
}

const isSystemctlBusUnavailable = isSystemdUserBusUnavailableDetail;

function isSystemdUserScopeUnavailable(detail: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

function isGenericSystemctlIsEnabledFailure(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.startsWith("command failed: systemctl") &&
    normalized.includes(" is-enabled ") &&
    !normalized.includes("permission denied") &&
    !normalized.includes("access denied") &&
    !normalized.includes("no space left") &&
    !normalized.includes("read-only file system") &&
    !normalized.includes("out of memory") &&
    !normalized.includes("cannot allocate memory")
  );
}

export function isNonFatalSystemdInstallProbeError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return isSystemctlBusUnavailable(normalized) || isGenericSystemctlIsEnabledFailure(normalized);
}

function resolveSystemctlDirectUserScopeArgs(): string[] {
  return ["--user"];
}

function resolveSystemctlMachineScopeUser(env: GatewayServiceEnv): string | null {
  const sudoUser = env.SUDO_USER?.trim();
  if (sudoUser && sudoUser !== "root") {
    return sudoUser;
  }
  const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function resolveSystemctlMachineUserScopeArgs(user: string): string[] {
  const trimmedUser = user.trim();
  if (!trimmedUser) {
    return [];
  }
  return ["--machine", `${trimmedUser}@`, "--user"];
}

function shouldFallbackToMachineUserScope(detail: string): boolean {
  if (!isSystemdUserBusUnavailableDetail(detail)) {
    return false;
  }
  // "Permission denied" means the bus socket exists but this process cannot connect to it.
  // The machine-scope approach targets the same bus infrastructure and will also fail,
  // so do not trigger the fallback in this case.
  return !detail.toLowerCase().includes("permission denied");
}

async function execSystemctlUser(
  env: GatewayServiceEnv,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const machineUser = resolveSystemctlMachineScopeUser(env);
  const sudoUser = env.SUDO_USER?.trim();

  // Under sudo, prefer the invoking non-root user's scope directly via machine scope.
  if (sudoUser && sudoUser !== "root" && machineUser) {
    const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
    if (machineScopeArgs.length > 0) {
      // Do not fall through to bare --user: under sudo that can target root's user manager.
      return await execSystemctl([...machineScopeArgs, ...args]);
    }
  }

  const directResult = await execSystemctl([...resolveSystemctlDirectUserScopeArgs(), ...args]);
  if (directResult.code === 0) {
    return directResult;
  }

  const detail = `${directResult.stderr} ${directResult.stdout}`.trim();
  if (!machineUser || !shouldFallbackToMachineUserScope(detail)) {
    return directResult;
  }

  const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
  if (machineScopeArgs.length === 0) {
    return directResult;
  }
  return await execSystemctl([...machineScopeArgs, ...args]);
}

export async function isSystemdUserServiceAvailable(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.trim();
  if (!detail) {
    return false;
  }
  return !isSystemdUserScopeUnavailable(detail);
}

async function assertSystemdAvailable(env: GatewayServiceEnv = process.env as GatewayServiceEnv) {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(detail)) {
    throw new Error("systemctl not available; systemd user services are required on Linux.");
  }
  if (!detail) {
    throw new Error("systemctl --user unavailable: unknown error");
  }
  if (!isSystemdUserScopeUnavailable(detail)) {
    return;
  }
  throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}

async function readUnitFileIfPresent(pathname: string): Promise<string | null> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readManagedDropInForMerge(pathname: string): Promise<string | null> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch {
    // Drop-in is strictly additive context for the merge view — an
    // unreadable drop-in must not fail the whole read, whether the cause is
    // ENOENT, a permission issue, or a stale mount. Mirrors
    // `resolveSystemdEnvironmentFiles`'s policy for missing EnvironmentFile=
    // entries.
    return null;
  }
}

async function writeSystemdUnit({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{
  unitPath: string;
  dropInPath: string;
  backedUp: boolean;
  mainUnitWritten: boolean;
  dropInWritten: boolean;
  migratedInlineManagedEnv: boolean;
}> {
  await assertSystemdAvailable(env);

  const unitPath = resolveSystemdUnitPath(env);
  const dropInPath = resolveSystemdManagedDropInPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.mkdir(path.dirname(dropInPath), { recursive: true });

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const stateDirDotEnvVars = Object.fromEntries(
    Object.entries(readStateDirDotEnvVarsFromStateDir(stateDir)).filter(([key, value]) => {
      const inlineValue = environment?.[key];
      if (typeof inlineValue !== "string") {
        return true;
      }
      return inlineValue.trim() === value.trim();
    }),
  );
  const environmentFiles = await writeSystemdGatewayEnvironmentFile({
    stateDir,
    dotenvVars: stateDirDotEnvVars,
  });
  const environmentSansDotEnvEntries = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([key, value]) => {
      if (typeof value !== "string") {
        return false;
      }
      const stateDirValue = stateDirDotEnvVars[key];
      if (typeof stateDirValue !== "string") {
        return true;
      }
      return value.trim() !== stateDirValue.trim();
    }),
  );
  const dropInText = buildSystemdManagedDropIn(environmentSansDotEnvEntries);

  const existingUnit = await readUnitFileIfPresent(unitPath);
  let backedUp = false;
  let mainUnitWritten = false;
  let migratedInlineManagedEnv = false;

  if (existingUnit === null) {
    // Fresh install — write a clean main unit with only user-preserved env.
    // Managed keys go into the drop-in exclusively so future upgrades can
    // rewrite the drop-in freely without touching the main unit.
    const freshUnit = buildSystemdUnit({
      description: serviceDescription,
      programArguments,
      workingDirectory,
      environment: environmentSansDotEnvEntries,
      environmentFiles,
    });
    await fs.writeFile(unitPath, freshUnit, "utf8");
    mainUnitWritten = true;
  } else {
    // Existing unit — migrate inline managed env out if present, update
    // ExecStart when the entry path has drifted between versions, and keep
    // everything else (user EnvironmentFile=, user Environment=, comments,
    // custom [Service] directives) verbatim.
    const strippedText = stripEnvironmentKeysFromSystemdUnit(
      stripManagedEnvFromSystemdUnit(existingUnit),
      Object.keys(stateDirDotEnvVars),
    );
    migratedInlineManagedEnv = strippedText !== existingUnit;
    const execStartResult = updateExecStartInSystemdUnit(strippedText, programArguments);
    const nextUnitText = (() => {
      if (!execStartResult.found) {
        return buildSystemdUnit({
          description: serviceDescription,
          programArguments,
          workingDirectory,
          environment: environmentSansDotEnvEntries,
          environmentFiles,
        });
      }
      const workingDirectoryResult = updateWorkingDirectoryInSystemdUnit(
        execStartResult.text,
        workingDirectory,
      );
      return updateEnvironmentFilesInSystemdUnit(workingDirectoryResult.text, environmentFiles)
        .text;
    })();

    if (nextUnitText !== existingUnit) {
      // Back up before rewriting so operators can diff if the migration or
      // ExecStart update removes something unexpected.
      const backupPath = `${unitPath}.bak`;
      await fs.copyFile(unitPath, backupPath);
      backedUp = true;
      await fs.writeFile(unitPath, nextUnitText, "utf8");
      mainUnitWritten = true;
    }
  }

  let dropInWritten = false;
  if (dropInText) {
    await fs.writeFile(dropInPath, dropInText, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(dropInPath, 0o600);
    dropInWritten = true;
  } else {
    // No managed env this round — remove a stale drop-in so we never leave
    // orphan managed state on disk after a reconfiguration shrinks the
    // managed set to zero.
    try {
      await fs.unlink(dropInPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return {
    unitPath,
    dropInPath,
    backedUp,
    mainUnitWritten,
    dropInWritten,
    migratedInlineManagedEnv,
  };
}

async function writeSystemdGatewayEnvironmentFile(params: {
  stateDir: string;
  dotenvVars: Record<string, string>;
}): Promise<string[]> {
  const entries = Object.entries(params.dotenvVars);
  if (entries.length === 0) {
    return [];
  }
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `state-dir .env contains a multiline value for ${key}; systemd EnvironmentFile values must be single-line`,
      );
    }
  }
  const envFilePath = path.join(params.stateDir, SYSTEMD_GATEWAY_DOTENV_FILENAME);
  const content = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
  return [envFilePath];
}

export async function stageSystemdService({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ unitPath: string; dropInPath: string }> {
  const { unitPath, dropInPath, backedUp, dropInWritten, migratedInlineManagedEnv } =
    await writeSystemdUnit(args);
  writeFormattedLines(
    stdout,
    [
      {
        label: "Staged systemd service",
        value: unitPath,
      },
      ...(dropInWritten
        ? [
            {
              label: "Managed env drop-in",
              value: dropInPath,
            },
          ]
        : []),
      ...(migratedInlineManagedEnv
        ? [
            {
              label: "Migrated inline managed env to drop-in",
              value: dropInPath,
            },
          ]
        : []),
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath, dropInPath };
}

async function activateSystemdService(params: { env: GatewayServiceEnv }) {
  const serviceName = resolveSystemdServiceName(params.env);
  const unitName = `${serviceName}.service`;
  const reload = await execSystemctlUser(params.env, ["daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await execSystemctlUser(params.env, ["enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await execSystemctlUser(params.env, ["restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }
}

export async function installSystemdService(
  args: GatewayServiceInstallArgs,
): Promise<{ unitPath: string; dropInPath: string }> {
  const { unitPath, dropInPath, backedUp, dropInWritten, migratedInlineManagedEnv } =
    await writeSystemdUnit(args);
  await activateSystemdService({ env: args.env });
  writeFormattedLines(
    args.stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
      ...(dropInWritten
        ? [
            {
              label: "Managed env drop-in",
              value: dropInPath,
            },
          ]
        : []),
      ...(migratedInlineManagedEnv
        ? [
            {
              label: "Migrated inline managed env to drop-in",
              value: dropInPath,
            },
          ]
        : []),
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath, dropInPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable(env);
  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  await execSystemctlUser(env, ["disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }

  // Also remove the managed drop-in (if any) and its parent `.d/` directory
  // when it becomes empty. Leaves untouched any user drop-ins the operator
  // added alongside the managed one.
  const dropInPath = resolveSystemdManagedDropInPath(env);
  try {
    await fs.unlink(dropInPath);
    stdout.write(`${formatLine("Removed managed env drop-in", dropInPath)}\n`);
  } catch {
    // Missing drop-in is the common case for pre-drop-in installs or fresh
    // unit configurations; do not surface that as an error.
  }
  try {
    const dropInDir = path.posix.dirname(dropInPath);
    await fs.rmdir(dropInDir);
  } catch {
    // Directory is either missing or still holds user drop-ins — leave it alone.
  }
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "stop" | "restart";
  label: string;
}) {
  const env = params.env ?? process.env;
  await assertSystemdAvailable(env);
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctlUser(env, [params.action, unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
  }
  params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}

export async function stopSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "stop",
    label: "Stopped systemd service",
  });
}

export async function restartSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "restart",
    label: "Restarted systemd service",
  });
  return { outcome: "completed" };
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const env = args.env ?? process.env;
  try {
    await fs.access(resolveSystemdUnitPath(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctlUser(env, ["is-enabled", unitName]);
  if (res.code === 0) {
    return true;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(detail) || isSystemdUnitNotEnabled(detail)) {
    return false;
  }
  throw new Error(`systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim());
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSystemdAvailable(env);
  } catch (err) {
    return {
      status: "unknown",
      detail: formatErrorMessage(err),
    };
  }
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctlUser(env, [
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
  ]);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = normalizeLowercaseStringOrEmpty(detail).includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = normalizeLowercaseStringOrEmpty(parsed.activeState);
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
  };
}
export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(env: GatewayServiceEnv): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return true;
  }
  return !isSystemctlMissing(readSystemctlDetail(res));
}

export async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctlUser(env, ["is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctlUser(env, ["disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
