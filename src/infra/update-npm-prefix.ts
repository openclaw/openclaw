// npm owns effective prefix resolution; callers consume its layout and launcher facts.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveExecutablePath } from "./executable-path.js";
import { pathExists } from "./fs-safe.js";
import { applyPathPrepend } from "./path-prepend.js";
import type { CommandRunner } from "./update-global-command-runner.js";

/** npm prefix layout paths needed to install, stage, and expose global bins. */
export type NpmGlobalPrefixLayout = {
  prefix: string;
  globalRoot: string;
  binDir: string;
};

/** Reads the command value after package-manager warnings printed on stdout. */
export function readPackageManagerProbeValue(stdout: string): string {
  const value = stdout.split(/\r?\n/u).findLast((line) => line.trim());
  return value?.trim() ?? "";
}

/**
 * Infers npm prefix, package root, and bin paths from an npm global root.
 * Direct `node_modules` roots are accepted only when the caller opts into them.
 */
export function resolveNpmGlobalPrefixLayoutFromGlobalRoot(
  globalRoot?: string | null,
  options: { allowDirectNodeModulesRoot?: boolean } = {},
): NpmGlobalPrefixLayout | null {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  if (path.basename(normalized) !== "node_modules") {
    return null;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) === "lib") {
    const prefix = path.dirname(parentDir);
    return {
      prefix,
      globalRoot: normalized,
      binDir: path.join(prefix, "bin"),
    };
  }
  if (process.platform === "win32") {
    return {
      prefix: parentDir,
      globalRoot: normalized,
      binDir: parentDir,
    };
  }
  if (options.allowDirectNodeModulesRoot) {
    return {
      prefix: parentDir,
      globalRoot: normalized,
      binDir: path.join(normalized, ".bin"),
    };
  }
  return null;
}

/**
 * Derives npm's global package and bin directories from a prefix root.
 * Used for staged installs where OpenClaw creates the prefix itself.
 */
export function resolveNpmGlobalPrefixLayoutFromPrefix(prefix: string): NpmGlobalPrefixLayout {
  const resolvedPrefix = path.resolve(prefix);
  const windows = process.platform === "win32";
  return {
    prefix: resolvedPrefix,
    globalRoot: path.join(resolvedPrefix, windows ? "" : "lib", "node_modules"),
    binDir: windows ? resolvedPrefix : path.join(resolvedPrefix, "bin"),
  };
}

export async function probeNpmGlobalPrefix(
  runCommand: CommandRunner,
  timeoutMs: number,
  command = "npm",
  diagnostics: string[] = [],
): Promise<NpmGlobalPrefixLayout | null> {
  const executable = resolveExecutablePath(command);
  const cli = executable
    ? process.platform === "win32"
      ? path.join(path.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js")
      : await fs.realpath(executable).catch(() => path.resolve(executable))
    : null;
  // npm owns npmrc precedence and expansion. Use the Node running this launcher,
  // even when PATH's npm belongs to a different Node installation.
  const argv =
    cli && path.basename(cli) === "npm-cli.js" && (await pathExists(cli))
      ? [process.execPath, cli, "prefix", "-g"]
      : [command, "prefix", "-g"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  applyPathPrepend(env, [path.dirname(process.execPath)]);
  const result = await runCommand(argv, { timeoutMs, env }).catch(() => null);
  const prefix = result?.code === 0 ? readPackageManagerProbeValue(result.stdout) : "";
  diagnostics.push(`${argv.join(" ")}: ${prefix || "unavailable"}`);
  return prefix && path.isAbsolute(prefix) ? resolveNpmGlobalPrefixLayoutFromPrefix(prefix) : null;
}

export async function inspectNpmLauncher(layout: NpmGlobalPrefixLayout) {
  const launcher = path.join(
    layout.binDir,
    process.platform === "win32" ? "openclaw.cmd" : "openclaw",
  );
  let launcherTarget = await fs.realpath(launcher).catch(() => null);
  if (process.platform === "win32" && launcherTarget) {
    const script = await fs.readFile(launcher, "utf8").catch(() => "");
    // npm shims check the interpreter first; the package entrypoint precedes %*.
    const relative = /"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+)"[ \t]+%\*/iu.exec(script)?.[1];
    launcherTarget = relative
      ? await fs
          .realpath(path.resolve(layout.binDir, ...relative.split(/[\\/]/u)))
          .catch(() => null)
      : null;
  }
  return { launcher, launcherTarget };
}
