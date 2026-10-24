import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";
import { hasErrnoCode } from "../infra/errno.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type { GatewayServiceEnv } from "./service-types.js";

export type SystemdEnvironmentFileSpec = [pathname: string, optional: boolean];
export type SystemdEnvironmentFilesParams = {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  failOnUnavailable?: boolean;
};

export function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  return input.replace(/%%|%h/gu, (specifier) =>
    specifier === "%%" ? "%" : normalizeWindowsPathSeparators(resolveDaemonHomeDir(env)),
  );
}

export function parseSystemdEnvironmentFileSpec(
  value: string,
  env: GatewayServiceEnv,
): SystemdEnvironmentFileSpec | undefined {
  const optional = value.startsWith("-");
  const pathname = expandSystemdSpecifier(optional ? value.slice(1) : value, env);
  // Native systemd ignores relative declarations rather than resolving them beside the unit.
  return path.posix.isAbsolute(pathname) ? [pathname, optional] : undefined;
}

async function expandSystemdEnvironmentFilePattern(pattern: string): Promise<string[]> {
  const [parts] = new Minimatch(pattern, {
    nobrace: true,
    noext: true,
    noglobstar: true,
    platform: "linux",
    optimizationLevel: 0,
  }).set;
  if (!parts) {
    return [];
  }
  if (parts.every((part) => typeof part === "string")) {
    return [parts.join("/")];
  }
  // Node's fs.glob treats backslashes as separators. Match the parsed POSIX
  // components instead, preserving escaped literals and symlink-sensitive parent segments.
  let pathnames = ["/"];
  for (const part of parts.slice(1)) {
    const matches: string[] = [];
    for (const parent of pathnames) {
      const prefix = parent.endsWith("/") ? parent : `${parent}/`;
      if (typeof part === "string") {
        matches.push(`${prefix}${part}`);
        continue;
      }
      try {
        for (const entry of await fs.readdir(parent)) {
          if (part instanceof RegExp && part.test(entry)) {
            matches.push(`${prefix}${entry}`);
          }
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
          throw error;
        }
      }
    }
    pathnames = matches;
  }
  const existing: string[] = [];
  for (const pathname of pathnames) {
    if (await lstatIfExists(pathname)) {
      existing.push(pathname);
    }
  }
  return existing;
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

export async function readSystemdEnvironmentFile(pathname: string) {
  const environment: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmedStart = rawLine.trimStart();
    if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";")) {
      continue;
    }
    const eq = trimmedStart.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmedStart.slice(0, eq).trim();
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
    for (const char of trimmedStart.slice(eq + 1)) {
      const whitespace = char === " " || char === "\t" || char === "\r";
      if (state === "pre") {
        if (whitespace) {
          continue;
        }
        if (char === "'" || char === '"') {
          state = char === "'" ? "single-quoted" : "double-quoted";
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
      if (state === "single-quoted" || state === "double-quoted") {
        const quote = state === "single-quoted" ? "'" : '"';
        if (char === quote) {
          state = "pre";
        } else if (state === "double-quoted" && char === "\\") {
          state = "double-quoted-escape";
        } else {
          literalDollar ||= char === "$";
          decoded += char;
        }
        continue;
      }
      const doubleQuoted: boolean = state === "double-quoted-escape";
      state = doubleQuoted ? "double-quoted" : "unquoted";
      if (doubleQuoted && !['"', "\\", "`", "$"].includes(char)) {
        decoded += "\\";
      }
      literalDollar ||= char === "$";
      decoded += char;
    }
    if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
      decoded = decoded.slice(0, trailingWhitespaceStart);
    }
    environment[key] = decoded;
    if (literalDollar && isUnresolvedShellReference(decoded)) {
      literalShellReferenceKeys.add(key);
    } else {
      literalShellReferenceKeys.delete(key);
    }
  }
  return { environment, literalShellReferenceKeys };
}

export async function resolveSystemdEnvironmentFiles(
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
