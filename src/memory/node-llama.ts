import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type NodeLlamaImporter = (specifier: string) => Promise<unknown>;

export function isNodeLlamaMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

export function resolveNodeLlamaCppInstallTarget(moduleUrl = import.meta.url): string {
  try {
    const require = createRequire(moduleUrl);
    const pkg = require("../../package.json") as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const version =
      typeof pkg.dependencies?.["node-llama-cpp"] === "string"
        ? pkg.dependencies["node-llama-cpp"].trim()
        : typeof pkg.optionalDependencies?.["node-llama-cpp"] === "string"
          ? pkg.optionalDependencies["node-llama-cpp"].trim()
          : "";
    return version ? `node-llama-cpp@${version}` : "node-llama-cpp";
  } catch {
    return "node-llama-cpp";
  }
}
function readModuleGlobalPaths(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const moduleNs = require("node:module") as { globalPaths?: string[] };
    return Array.isArray(moduleNs.globalPaths)
      ? moduleNs.globalPaths.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function resolveNodeModuleRoots(params: {
  metaUrl: string;
  env?: NodeJS.ProcessEnv;
  globalPaths?: readonly string[];
}): string[] {
  const roots = new Set<string>();

  try {
    let current = path.dirname(fileURLToPath(params.metaUrl));
    while (current) {
      if (path.basename(current) === "node_modules") {
        roots.add(current);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch {
    // Ignore invalid/non-file meta URLs.
  }

  const prefix = params.env?.["npm_config_prefix"]?.trim();
  if (prefix) {
    roots.add(path.resolve(prefix, "lib", "node_modules"));
    roots.add(path.resolve(prefix, "node_modules"));
  }

  for (const globalPath of params.globalPaths ?? readModuleGlobalPaths()) {
    const trimmed = globalPath.trim();
    if (trimmed) {
      roots.add(path.resolve(trimmed));
    }
  }

  return [...roots];
}

function resolveNodeLlamaImportCandidates(params: {
  metaUrl: string;
  env?: NodeJS.ProcessEnv;
  globalPaths?: readonly string[];
}): string[] {
  const candidates = new Set<string>();
  const baseRequire = createRequire(params.metaUrl);

  const tryResolve = (request: NodeJS.Require, specifier: string) => {
    try {
      candidates.add(pathToFileURL(request.resolve(specifier)).href);
    } catch {
      // Ignore missing candidates and keep searching.
    }
  };

  tryResolve(baseRequire, "node-llama-cpp");

  for (const root of resolveNodeModuleRoots(params)) {
    tryResolve(createRequire(path.join(root, "__openclaw-node-llama__.cjs")), "node-llama-cpp");
  }

  return [...candidates];
}

export async function importNodeLlamaCpp(params?: {
  metaUrl?: string;
  env?: NodeJS.ProcessEnv;
  globalPaths?: readonly string[];
  importer?: NodeLlamaImporter;
}) {
  const importer = params?.importer ?? ((specifier: string) => import(specifier));
  try {
    return await importer("node-llama-cpp");
  } catch (err) {
    if (!isNodeLlamaMissingError(err)) {
      throw err;
    }
    for (const candidate of resolveNodeLlamaImportCandidates({
      metaUrl: params?.metaUrl ?? import.meta.url,
      env: params?.env,
      globalPaths: params?.globalPaths,
    })) {
      try {
        return await importer(candidate);
      } catch (candidateErr) {
        if (!isNodeLlamaMissingError(candidateErr)) {
          throw candidateErr;
        }
      }
    }
    throw err;
  }
}
