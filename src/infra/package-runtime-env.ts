import fs from "node:fs/promises";
import path from "node:path";
import { resolveExecutablePath } from "./executable-path.js";
import { pathExists } from "./fs-safe.js";
import { applyPathPrepend } from "./path-prepend.js";

function resolveRuntimePathApi(value: string): typeof path.posix | typeof path.win32 | null {
  const pathApi =
    process.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")
      ? path.win32
      : path.posix;
  return pathApi.isAbsolute(value) ? pathApi : null;
}

/** Pins package-manager lifecycle subprocesses to the Node runtime selected for activation. */
export function createPackageRuntimeEnv(
  env: NodeJS.ProcessEnv | undefined,
  nodePath: string | null,
): NodeJS.ProcessEnv | undefined {
  const trimmed = nodePath?.trim();
  if (!trimmed) {
    return env;
  }
  const pathApi = resolveRuntimePathApi(trimmed);
  if (!pathApi) {
    return env;
  }
  const result = Object.fromEntries(
    Object.entries(env ?? process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  applyPathPrepend(result, [pathApi.dirname(trimmed)]);
  return result;
}

/** Resolves npm beside the selected Node so packing cannot fall back to a different shell Node. */
export function resolvePackageRuntimeNpmCommand(nodePath: string | null): string | null {
  const trimmed = nodePath?.trim();
  if (!trimmed) {
    return null;
  }
  const pathApi = resolveRuntimePathApi(trimmed);
  if (!pathApi) {
    return null;
  }
  return pathApi.join(pathApi.dirname(trimmed), pathApi === path.win32 ? "npm.cmd" : "npm");
}

function resolveNpmCliCandidates(
  commandPath: string,
  pathApi: typeof path.posix | typeof path.win32,
): string[] {
  const commandDir = pathApi.dirname(commandPath);
  const candidates =
    pathApi.basename(commandPath).toLowerCase() === "npm-cli.js" ? [commandPath] : [];
  candidates.push(
    pathApi.join(commandDir, "node_modules", "npm", "bin", "npm-cli.js"),
    pathApi.resolve(commandDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  return candidates;
}

/** Resolves npm so every lifecycle executes under the selected managed-service Node. */
export async function resolvePackageRuntimeNpmInvocation(params: {
  nodePath: string | null;
  fallbackCommand: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[] | null> {
  const nodePath = params.nodePath?.trim();
  if (!nodePath) {
    return null;
  }
  const nodePathApi = resolveRuntimePathApi(nodePath);
  if (!nodePathApi) {
    return null;
  }

  const adjacentNpmCommand = resolvePackageRuntimeNpmCommand(nodePath);
  if (adjacentNpmCommand && (await pathExists(adjacentNpmCommand))) {
    return [adjacentNpmCommand];
  }

  const fallbackPath = resolveExecutablePath(params.fallbackCommand, {
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
    ...(params.env === undefined ? {} : { env: params.env }),
  });
  if (!fallbackPath) {
    return null;
  }
  const realFallbackPath = await fs.realpath(fallbackPath).catch(() => fallbackPath);
  const candidates = [...new Set([realFallbackPath, fallbackPath])].flatMap((commandPath) => {
    const pathApi = resolveRuntimePathApi(commandPath);
    return pathApi ? resolveNpmCliCandidates(commandPath, pathApi) : [];
  });
  for (const candidate of new Set(candidates)) {
    if (await pathExists(candidate)) {
      return [nodePath, candidate];
    }
  }
  return null;
}
