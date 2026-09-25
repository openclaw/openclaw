/** Linux systemd unit paths and environment-file parsing. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveGatewaySystemdServiceName } from "./constants.js";
import { normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import {
  ServiceDefinitionInspectionError,
  ServiceOwnershipRefusalError,
  findServiceOwnershipRefusal,
} from "./service-inspection-error.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandSnapshot,
  GatewayServiceEnv,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceManagedOverrides,
  GatewayServiceReadOptions,
} from "./service-types.js";
import { createSystemdCommandQuery } from "./systemd-command-query.js";
import { expandSystemdEnvironmentFilePattern } from "./systemd-environment-file-pattern.js";
import type {
  SystemdCommandSnapshotParams,
  SystemdEnvironmentFilesParams,
  SystemdEnvironmentFileSpec,
} from "./systemd-service-files.types.js";
import {
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  splitSystemdLogicalLines,
  splitSystemdEnvironmentWords,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";
const SYSTEMD_NODE_DOTENV_FILENAME = "node.systemd.env";

export function assertSystemdServiceAccount(user: string) {
  const account = os.userInfo();
  if (
    user !== account.username &&
    user !== String(account.uid) &&
    !(user === "" && account.uid === 0)
  ) {
    throw new ServiceOwnershipRefusalError("systemd-account-refused");
  }
  return account;
}

export function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

export function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

export function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

// Unit file parsing/rendering: see systemd-unit.ts

const UNKNOWN_SYSTEMD_OVERRIDES = {
  launcher: "command",
  environment: true,
} satisfies GatewayServiceManagedOverrides;

async function buildSystemdCommandSnapshot(
  params: SystemdCommandSnapshotParams,
): Promise<GatewayServiceCommandSnapshot> {
  const fileEnvironment = await resolveSystemdEnvironmentFiles(params);
  const environment = { ...params.inlineEnvironment, ...fileEnvironment };
  const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> =
    Object.fromEntries(Object.keys(params.inlineEnvironment).map((key) => [key, "inline"]));
  for (const key of Object.keys(fileEnvironment)) {
    environmentValueSources[key] = Object.hasOwn(params.inlineEnvironment, key)
      ? "inline-and-file"
      : "file";
  }
  for (const assignment of params.unsetEnvironment) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    if (separator < 0 || environment[key] === assignment.slice(separator + 1)) {
      delete environment[key];
      delete environmentValueSources[key];
    }
  }
  return {
    programArguments: params.programArguments,
    ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
    ...(Object.keys(environment).length > 0 ? { environment, environmentValueSources } : {}),
  };
}

async function readSystemdManagerCommand(
  env: GatewayServiceEnv,
  localDefinition: GatewayServiceCommandSnapshot | null,
  managedUnsetEnvironment: string[],
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const manager = "org.freedesktop.systemd1";
  const target = opts?.systemdReadTarget;
  const unitName = target?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const systemScope = target?.scope === "system";
  const unavailable = () => new Error("Effective systemd service command could not be inspected.");
  const inspection = opts?.requireLoaded ? opts.loadForInspection : undefined;
  const { query, binding, destination, close } = await createSystemdCommandQuery(
    env,
    unitName,
    opts,
    unavailable,
  );
  try {
    const assertAbsentWithoutLoading = async (): Promise<null> => {
      // Missing loaded objects do not prove an authored/native unit definition is absent.
      if (localDefinition) {
        throw unavailable();
      }
      const fileState = await query(
        [
          "call",
          destination,
          "/org/freedesktop/systemd1",
          `${manager}.Manager`,
          "GetUnitFileState",
          "s",
          unitName,
        ],
        ["s"],
      );
      if (fileState !== null) {
        throw unavailable();
      }
      return null;
    };
    const loaded = await query(
      [
        "call",
        destination,
        "/org/freedesktop/systemd1",
        `${manager}.Manager`,
        opts?.requireLoaded && !inspection ? "GetUnit" : "LoadUnit",
        "s",
        unitName,
      ],
      ["o"],
    );
    if (!loaded) {
      return opts?.requireLoaded ? await assertAbsentWithoutLoading() : null;
    }
    const loadedUnit = loaded[0];
    const unitPath = Array.isArray(loadedUnit) && loadedUnit.length === 1 ? loadedUnit[0] : null;
    if (typeof unitPath !== "string" || !unitPath) {
      throw unavailable();
    }
    const readProperties = (scope: "Unit" | "Service", names: string[], signatures: string[]) =>
      query(["get-property", destination, unitPath, `${manager}.${scope}`, ...names], signatures);
    const isStringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string");
    const unitProperties = await readProperties(
      "Unit",
      ["FragmentPath", "DropInPaths", "NeedDaemonReload", "LoadState"],
      ["s", "as", "b", "s"],
    );
    const [sourcePath, dropInPaths, reloadPending, loadState] = unitProperties ?? [];
    // LoadUnit also returns objects for missing units; only LoadState proves absence.
    if (loadState === "not-found") {
      return opts?.requireLoaded ? await assertAbsentWithoutLoading() : null;
    }
    if (
      loadState !== "loaded" ||
      typeof sourcePath !== "string" ||
      !sourcePath ||
      !isStringArray(dropInPaths) ||
      dropInPaths.some((pathname) => !pathname) ||
      typeof reloadPending !== "boolean"
    ) {
      throw unavailable();
    }
    const properties = await readProperties(
      "Service",
      [
        "ExecStart",
        "WorkingDirectory",
        "Environment",
        "EnvironmentFiles",
        "UnsetEnvironment",
        ...(systemScope ? ["User"] : []),
      ],
      ["a(sasbttttuii)", "s", "as", "a(sb)", "as", ...(systemScope ? ["s"] : [])],
    );
    const [executions, workingDirectory, assignments, fileSpecs, unset, user] = properties ?? [];
    const execution = Array.isArray(executions) && executions.length === 1 ? executions[0] : null;
    const programArguments = Array.isArray(execution) ? execution[1] : null;
    if (
      !Array.isArray(execution) ||
      execution.length !== 10 ||
      typeof execution[0] !== "string" ||
      execution[0].length === 0 ||
      typeof execution[2] !== "boolean" ||
      !execution.slice(3).every(Number.isInteger) ||
      !isStringArray(programArguments) ||
      programArguments.length === 0 ||
      typeof workingDirectory !== "string" ||
      !isStringArray(assignments) ||
      !Array.isArray(fileSpecs) ||
      !fileSpecs.every(
        (spec): spec is [string, boolean] =>
          Array.isArray(spec) &&
          spec.length === 2 &&
          typeof spec[0] === "string" &&
          path.posix.isAbsolute(spec[0]) &&
          typeof spec[1] === "boolean",
      ) ||
      !isStringArray(unset) ||
      unset.some((assignment) => !assignment || assignment.startsWith("="))
    ) {
      throw unavailable();
    }
    const inlineEnvironment: Record<string, string> = {};
    for (const assignment of assignments) {
      const separator = assignment.indexOf("=");
      if (separator <= 0) {
        throw unavailable();
      }
      inlineEnvironment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    }
    if (systemScope && typeof user !== "string") {
      throw unavailable();
    }
    const account =
      systemScope && typeof user === "string"
        ? opts?.requireEffective
          ? assertSystemdServiceAccount(user)
          : os.userInfo()
        : undefined;
    const sameAccount =
      account &&
      (user === account.username ||
        user === String(account.uid) ||
        (user === "" && account.uid === 0));

    await binding?.verify();
    const managedDefinition =
      !systemScope && sourcePath === resolveSystemdUnitPath(env) ? localDefinition : null;
    const managedOverrides =
      !reloadPending && managedDefinition
        ? await readSystemdDropInOverrides(dropInPaths, managedUnsetEnvironment, env).catch(
            () => UNKNOWN_SYSTEMD_OVERRIDES,
          )
        : UNKNOWN_SYSTEMD_OVERRIDES;
    const snapshot = await buildSystemdCommandSnapshot({
      programArguments,
      workingDirectory: workingDirectory.replace(/^!/, ""),
      inlineEnvironment,
      environmentFileSpecs: fileSpecs,
      unsetEnvironment: unset,
      failOnUnavailable: opts?.requireEffective,
    });
    if (
      sameAccount &&
      !Object.hasOwn(snapshot.environment ?? {}, "HOME") &&
      !unset.some((assignment) => assignment === "HOME" || assignment === `HOME=${account.homedir}`)
    ) {
      snapshot.environment = { ...snapshot.environment, HOME: account.homedir };
    }
    return {
      ...snapshot,
      ...(managedDefinition && managedOverrides ? { managedDefinition, managedOverrides } : {}),
      sourcePath,
      definitionPaths: [sourcePath, ...dropInPaths],
      ...(reloadPending ? { reloadPending: true } : {}),
    };
  } finally {
    await close();
  }
}

async function readSystemdDropInOverrides(
  dropInPaths: string[],
  managedUnsetEnvironment: string[],
  env: GatewayServiceEnv,
): Promise<GatewayServiceManagedOverrides> {
  const inlineEnvironmentKeys = new Set<string>();
  const fileEnvironmentKeys = new Set<string>();
  const unsetEnvironmentKeys = new Set<string>();
  const overrides: GatewayServiceManagedOverrides = {};
  let resetInline = false;
  let resetFiles = false;
  for (const pathname of dropInPaths) {
    const content = await fs.readFile(pathname, "utf8");
    let inService = false;
    // Loaded drop-ins own directives even when their current values equal the managed base.
    for (const rawLine of splitSystemdLogicalLines(content)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) {
          throw new Error("Invalid systemd drop-in section");
        }
        inService = line === "[Service]";
        continue;
      }
      if (!inService) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator < 0) {
        throw new Error("Invalid systemd drop-in directive");
      }
      const directive = line.slice(0, separator).trim();
      if (directive === "ExecStart" || directive === "WorkingDirectory") {
        overrides.launcher =
          directive === "ExecStart" ? "command" : (overrides.launcher ?? "working-directory");
      } else if (["Environment", "EnvironmentFile", "UnsetEnvironment"].includes(directive)) {
        const value = line.slice(separator + 1).trim();
        if (!value) {
          if (directive === "Environment") {
            inlineEnvironmentKeys.clear();
            resetInline = true;
          } else if (directive === "EnvironmentFile") {
            fileEnvironmentKeys.clear();
            resetFiles = true;
          } else {
            unsetEnvironmentKeys.clear();
            for (const assignment of managedUnsetEnvironment) {
              unsetEnvironmentKeys.add(assignment.split("=", 1)[0] ?? assignment);
            }
          }
        } else if (directive === "Environment") {
          const assignments = parseSystemdEnvAssignments(value);
          if (assignments.length !== splitSystemdEnvironmentWords(value).length) {
            throw new Error("Invalid systemd drop-in environment");
          }
          for (const { key } of assignments) {
            inlineEnvironmentKeys.add(key);
          }
        } else if (directive === "UnsetEnvironment") {
          for (const assignment of splitSystemdEnvironmentWords(value)) {
            const key = assignment.split("=", 1)[0];
            if (!key) {
              throw new Error("Invalid systemd drop-in environment removal");
            }
            unsetEnvironmentKeys.add(key);
          }
        } else if (value.replace(/%%|%h/gu, "").includes("%")) {
          overrides.environment = true;
        } else {
          try {
            const spec = parseSystemdEnvironmentFileSpec(value, env);
            const fileEnvironment = await resolveSystemdEnvironmentFiles({
              environmentFileSpecs: spec ? [spec] : [],
              failOnUnavailable: true,
            });
            for (const key of Object.keys(fileEnvironment)) {
              fileEnvironmentKeys.add(key);
            }
          } catch {
            overrides.environment = true;
          }
        }
      }
    }
  }
  if (overrides.environment !== true) {
    const ownedKeys = [
      ...new Set([...inlineEnvironmentKeys, ...fileEnvironmentKeys, ...unsetEnvironmentKeys]),
    ];
    if (ownedKeys.length > 0 || resetInline || resetFiles) {
      overrides.environment = {
        ...(ownedKeys.length > 0 ? { keys: ownedKeys } : {}),
        ...(resetInline ? { resetInline: true } : {}),
        ...(resetFiles ? { resetFiles: true } : {}),
      };
    }
  }
  // A known-empty set preserves the authored definition without mistaking native
  // defaults (such as a user service's home cwd) for operator-owned overrides.
  return overrides;
}

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  try {
    const target =
      options?.systemdReadTarget ??
      (await (await import("./systemd-scope.js")).findInstalledSystemdGatewayScope(env));
    const opts = target ? { ...options, systemdReadTarget: target } : options;
    const unitPath = target?.unitPath ?? resolveSystemdUnitPath(env);
    const content = await fs.readFile(unitPath, "utf8").catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw new ServiceDefinitionInspectionError(unitPath);
      }
      return null;
    });
    if (target?.scope === "system") {
      const command = await readSystemdManagerCommand(
        env,
        content === null ? null : { programArguments: [] },
        [],
        opts,
      );
      opts?.onCommandInspection?.({ kind: command || content !== null ? "present" : "absent" });
      return command;
    }
    let execStart = "";
    let workingDirectory = "";
    let inlineEnvironment: Record<string, string> = {};
    const environmentFileSpecs: SystemdEnvironmentFileSpec[] = [];
    const unsetEnvironment: string[] = [];
    for (const rawLine of splitSystemdLogicalLines(content ?? "")) {
      const line = rawLine.trim();
      const separator = line.indexOf("=");
      if (separator < 0 || line.startsWith("#")) {
        continue;
      }
      const directive = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (directive === "ExecStart") {
        execStart = value;
      } else if (directive === "WorkingDirectory") {
        const expanded = expandSystemdSpecifier(value.replace(/^-/, ""), env);
        // Undo the renderer's terminal /. without collapsing symlink-sensitive .. segments.
        workingDirectory = expanded.endsWith("/.") ? expanded.slice(0, -2) || "/" : expanded;
      } else if (directive === "Environment") {
        if (!value) {
          inlineEnvironment = {};
        }
        for (const parsed of parseSystemdEnvAssignments(value)) {
          inlineEnvironment[parsed.key] = expandSystemdSpecifier(parsed.value, env);
        }
      } else if (directive === "EnvironmentFile" || directive === "UnsetEnvironment") {
        const file = directive === "EnvironmentFile";
        const entries = file ? environmentFileSpecs : unsetEnvironment;
        if (!value) {
          entries.length = 0;
        } else if (file) {
          const spec = parseSystemdEnvironmentFileSpec(value, env);
          if (spec) {
            environmentFileSpecs.push(spec);
          }
        } else {
          unsetEnvironment.push(...splitSystemdEnvironmentWords(value));
        }
      }
    }
    // Only manager-effective EnvironmentFile entries are required; drop-ins can reset the base.
    const managedDefinition = await buildSystemdCommandSnapshot({
      programArguments: parseSystemdExecStart(execStart).map((argument) =>
        expandSystemdSpecifier(argument, env),
      ),
      workingDirectory,
      inlineEnvironment,
      environmentFileSpecs,
      unsetEnvironment,
    });
    const localDefinition = content === null ? null : managedDefinition;
    const manager = await readSystemdManagerCommand(env, localDefinition, unsetEnvironment, opts)
      .then((command) => {
        opts?.onCommandInspection?.({ kind: command || localDefinition ? "present" : "absent" });
        return command;
      })
      .catch((error: unknown) => {
        if (opts?.requireEffective || findServiceOwnershipRefusal(error)) {
          throw error;
        }
        opts?.onCommandInspection?.({ kind: "unavailable", error });
        return null;
      });
    if (manager || opts?.requireEffective || !managedDefinition.programArguments.length) {
      return manager;
    }
    return {
      ...managedDefinition,
      managedDefinition,
      managedOverrides: UNKNOWN_SYSTEMD_OVERRIDES,
      sourcePath: unitPath,
    };
  } catch (error) {
    options?.onCommandInspection?.({ kind: "unavailable", error });
    if (options?.requireEffective || findServiceOwnershipRefusal(error)) {
      throw error;
    }
    return null;
  }
}

export function resolveSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string {
  const serviceKind = params.environment?.OPENCLAW_SERVICE_KIND?.trim();
  const filename =
    serviceKind === "node" ? SYSTEMD_NODE_DOTENV_FILENAME : SYSTEMD_GATEWAY_DOTENV_FILENAME;
  return path.join(params.stateDir, filename);
}

export function resolveLegacyNodeSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string | null {
  if (params.environment?.OPENCLAW_SERVICE_KIND?.trim() !== "node") {
    return null;
  }
  return path.join(params.stateDir, SYSTEMD_GATEWAY_DOTENV_FILENAME);
}

export function isNodeSystemdEnvironment(env: GatewayServiceEnv): boolean {
  return env.OPENCLAW_SERVICE_KIND?.trim() === "node";
}

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  return input.replace(/%%|%h/gu, (specifier) =>
    specifier === "%%" ? "%" : normalizeWindowsPathSeparators(resolveDaemonHomeDir(env)),
  );
}

function parseSystemdEnvironmentFileSpec(
  value: string,
  env: GatewayServiceEnv,
): SystemdEnvironmentFileSpec | undefined {
  const optional = value.startsWith("-");
  const pathname = expandSystemdSpecifier(optional ? value.slice(1) : value, env);
  // Native systemd ignores relative declarations rather than resolving them beside the unit.
  return path.posix.isAbsolute(pathname) ? [pathname, optional] : undefined;
}

function decodeSystemdEnvironmentFileValue(rawValue: string): {
  value: string;
  literalDollar: boolean;
} {
  type ParseState =
    | "pre"
    | "unquoted"
    | "unquoted-escape"
    | "single-quoted"
    | "double-quoted"
    | "double-quoted-escape";

  // Match systemd parse_env_file_internal: closing quotes return to pre ("foo"bar -> foobar).
  let state: ParseState = "pre";
  let decoded = "";
  let literalDollar = false;
  let trailingWhitespaceStart: number | undefined;
  for (const char of rawValue) {
    const whitespace = char === " " || char === "\t" || char === "\r";
    if (state === "pre") {
      if (whitespace) {
        continue;
      }
      if (char === "'") {
        state = "single-quoted";
        continue;
      }
      if (char === '"') {
        state = "double-quoted";
        continue;
      }
      if (char === "\\") {
        state = "unquoted-escape";
        continue;
      }
      state = "unquoted";
      decoded += char;
      continue;
    }
    if (state === "unquoted") {
      if (char === "\\") {
        state = "unquoted-escape";
        trailingWhitespaceStart = undefined;
        continue;
      }
      if (whitespace) {
        trailingWhitespaceStart ??= decoded.length;
      } else {
        trailingWhitespaceStart = undefined;
      }
      decoded += char;
      continue;
    }
    if (state === "unquoted-escape") {
      state = "unquoted";
      literalDollar ||= char === "$";
      decoded += char;
      continue;
    }
    if (state === "single-quoted") {
      if (char === "'") {
        state = "pre";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    if (state === "double-quoted") {
      if (char === '"') {
        state = "pre";
      } else if (char === "\\") {
        state = "double-quoted-escape";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    state = "double-quoted";
    if (['"', "\\", "`", "$"].includes(char)) {
      literalDollar ||= char === "$";
      decoded += char;
    } else {
      decoded += `\\${char}`;
    }
  }
  if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
    decoded = decoded.slice(0, trailingWhitespaceStart);
  }
  return { value: decoded, literalDollar };
}

function parseEnvironmentFileLine(
  rawLine: string,
): { key: string; value: string; literalShellReference: boolean } | null {
  const trimmedStart = rawLine.trimStart();
  if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";")) {
    return null;
  }
  const eq = trimmedStart.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmedStart.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const decoded = decodeSystemdEnvironmentFileValue(trimmedStart.slice(eq + 1));
  return {
    key,
    value: decoded.value,
    literalShellReference: decoded.literalDollar && isUnresolvedShellReference(decoded.value),
  };
}

function serializeSystemdEnvironmentFileValue(value: string): string {
  // Quote only systemd's supported escapes so credential bytes survive EnvironmentFile parsing.
  if (!/[\s\\'"`$]/u.test(value)) {
    return value;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$");
  return `"${escaped}"`;
}

export function serializeSystemdEnvironmentFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${serializeSystemdEnvironmentFileValue(value)}`)
    .join("\n");
}

export async function readSystemdEnvironmentFile(pathname: string): Promise<{
  environment: Record<string, string>;
  literalShellReferenceKeys: Set<string>;
}> {
  const environment: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(rawLine);
    if (!parsed) {
      continue;
    }
    environment[parsed.key] = parsed.value;
    if (parsed.literalShellReference) {
      literalShellReferenceKeys.add(parsed.key);
    } else {
      literalShellReferenceKeys.delete(parsed.key);
    }
  }
  return { environment, literalShellReferenceKeys };
}

async function resolveSystemdEnvironmentFiles(
  params: SystemdEnvironmentFilesParams,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const failIfUnavailable = (error: unknown, optional: boolean) => {
    if (params.failOnUnavailable && !optional) {
      throw error;
    }
  };
  for (const [pattern, optional] of params.environmentFileSpecs) {
    let pathnames: string[];
    try {
      pathnames = await expandSystemdEnvironmentFilePattern(pattern);
    } catch (error) {
      failIfUnavailable(error, optional);
      continue;
    }
    pathnames.sort();
    if (params.failOnUnavailable && !optional && pathnames.length === 0) {
      throw new Error("Missing systemd environment file");
    }
    for (const filePath of pathnames) {
      try {
        Object.assign(resolved, (await readSystemdEnvironmentFile(filePath)).environment);
      } catch (error) {
        failIfUnavailable(error, optional);
        // Diagnostics skip unavailable files, including non-optional ones.
        continue;
      }
    }
  }
  return resolved;
}
