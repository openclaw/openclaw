import fs from "node:fs/promises";
import path from "node:path";
import { resolveExecutablePath } from "./executable-path.js";
import { pathExists } from "./fs-safe.js";
import { applyPathPrepend } from "./path-prepend.js";

type RuntimePathApi = typeof path.posix;

function resolveRuntimePathApi(value: string): RuntimePathApi | null {
  const pathApi =
    /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("//")
      ? path.win32
      : value.startsWith("/")
        ? path.posix
        : process.platform === "win32"
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
      .map(([key, value]) => [key, value]),
  );
  applyPathPrepend(result, [pathApi.dirname(trimmed)]);
  return result;
}

/** Resolves npm beside the selected Node so packing cannot fall back to a different shell Node. */
function resolvePackageRuntimeNpmCommand(nodePath: string | null): string | null {
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

/** Resolves the prefix owned by an npm invocation without executing it under another Node. */
export function resolvePackageRuntimeNpmPrefix(invocation: readonly string[]): string | null {
  if (invocation.length === 1) {
    const command = invocation[0]?.trim();
    const pathApi = command ? resolveRuntimePathApi(command) : null;
    if (!command || !pathApi) {
      return null;
    }
    const basename = pathApi.basename(command).toLowerCase();
    if (basename !== "npm" && basename !== "npm.cmd") {
      return null;
    }
    const commandDir = pathApi.dirname(command);
    return pathApi === path.win32 ? commandDir : pathApi.dirname(commandDir);
  }

  const cliPath = invocation[1]?.trim();
  const pathApi = cliPath ? resolveRuntimePathApi(cliPath) : null;
  if (!cliPath || !pathApi || pathApi.basename(cliPath).toLowerCase() !== "npm-cli.js") {
    return null;
  }
  const npmDir = pathApi.dirname(pathApi.dirname(cliPath));
  if (pathApi.basename(npmDir).toLowerCase() !== "npm") {
    return null;
  }
  const nodeModulesDir = pathApi.dirname(npmDir);
  if (pathApi.basename(nodeModulesDir).toLowerCase() !== "node_modules") {
    return null;
  }
  const parentDir = pathApi.dirname(nodeModulesDir);
  return pathApi !== path.win32 && pathApi.basename(parentDir).toLowerCase() === "lib"
    ? pathApi.dirname(parentDir)
    : parentDir;
}

function resolveNpmCliCandidates(commandPath: string, pathApi: RuntimePathApi): string[] {
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
  allowAdjacentFallback?: boolean;
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
  const hasAdjacentNpm = adjacentNpmCommand ? await pathExists(adjacentNpmCommand) : false;

  const fallbackPath = resolveExecutablePath(params.fallbackCommand, {
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
    ...(params.env === undefined ? {} : { env: params.env }),
  });
  if (!fallbackPath) {
    return params.allowAdjacentFallback !== false && hasAdjacentNpm && adjacentNpmCommand
      ? [adjacentNpmCommand]
      : null;
  }
  const realFallbackPath = await fs.realpath(fallbackPath).catch(() => fallbackPath);
  const realAdjacentNpmPath =
    hasAdjacentNpm && adjacentNpmCommand
      ? await fs.realpath(adjacentNpmCommand).catch(() => adjacentNpmCommand)
      : null;
  if (
    adjacentNpmCommand &&
    realAdjacentNpmPath &&
    path.resolve(realAdjacentNpmPath) === path.resolve(realFallbackPath)
  ) {
    return [adjacentNpmCommand];
  }
  const candidates = [...new Set([realFallbackPath, fallbackPath])].flatMap((commandPath) => {
    const pathApi = resolveRuntimePathApi(commandPath);
    return pathApi ? resolveNpmCliCandidates(commandPath, pathApi) : [];
  });
  for (const candidate of new Set(candidates)) {
    if (await pathExists(candidate)) {
      return [nodePath, candidate];
    }
  }
  return params.allowAdjacentFallback !== false && hasAdjacentNpm && adjacentNpmCommand
    ? [adjacentNpmCommand]
    : null;
}
