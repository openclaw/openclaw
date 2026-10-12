/** Native systemd environment-file serialization, reading, and effective file overlays. */
import fs from "node:fs/promises";
import { parseSystemdEnvironmentFileLine } from "./systemd-environment-file-parser.js";
import { expandSystemdEnvironmentFilePattern } from "./systemd-environment-file-pattern.js";

export type SystemdEnvironmentFileSpec = [pathname: string, optional: boolean];
export type SystemdEnvironmentFilesParams = {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  failOnUnavailable?: boolean;
};

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
    const parsed = parseSystemdEnvironmentFileLine(rawLine);
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
