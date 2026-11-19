import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRootJsonObjectSync } from "@openclaw/fs-safe/json";
import { isEmbeddedStandaloneModule, resolveRuntimeScriptEnv } from "../../cli-invocation.mjs";
import { resolveRuntimeProcessDistRoot } from "../../runtime-process-bootstrap.generated.mjs";
import { resolveForwardedNodeCompilerArgs } from "../bootstrap/node-compiler-args.js";
import { isBunRuntime } from "../daemon/runtime-binary.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

declare const SEALED_RUNTIME_BUILD: boolean;

/** Resolve an explicit installed root, source sibling, or stable packaged worker path. */
export function resolveRuntimeWorkerUrl(params: {
  currentModuleUrl: string;
  sourceWorkerName: string;
  distWorkerPath: string;
  /** Explicit source language for generated entries whose owner has a different extension. */
  sourceExtension?: ".ts" | ".mts" | ".mjs";
  root?: string;
  /** Package-local output when the nearest dist belongs to this package. */
  package?: { name: string; distWorkerPath: string };
}): URL {
  if (params.root !== undefined) {
    return pathToFileURL(path.join(params.root, "dist", params.distWorkerPath));
  }
  const currentPath = fileURLToPath(params.currentModuleUrl);
  const distRoot = resolveRuntimeProcessDistRoot(currentPath);
  if (distRoot !== undefined) {
    let workerPath = params.distWorkerPath;
    if (params.package) {
      const packageRoot = path.resolve(distRoot, "..");
      const manifest = readRootJsonObjectSync({
        rootDir: packageRoot,
        relativePath: "package.json",
        boundaryLabel: "runtime worker package",
        rejectHardlinks: false,
      });
      if (!manifest.ok) {
        throw new Error(`Cannot resolve runtime worker package: ${packageRoot}/package.json`);
      }
      // Standalone plugins keep their own dist root, including shared build chunks.
      if (manifest.value.name === params.package.name) {
        workerPath = params.package.distWorkerPath;
      }
    }
    return pathToFileURL(path.join(distRoot, workerPath));
  }
  const extension = params.sourceExtension ?? (path.extname(currentPath) || ".js");
  return new URL(`./${params.sourceWorkerName}${extension}`, params.currentModuleUrl);
}

function isBunTargetRuntime(execPath: string): boolean {
  // Current runtime metadata also identifies renamed binaries; foreign paths keep their own selection.
  return execPath === process.execPath ? Boolean(process.versions.bun) : isBunRuntime(execPath);
}

/** Disable implicit package installation in OpenClaw-owned Bun processes, including service definitions. */
export function resolveRuntimeInstallPolicyArgs(execPath = process.execPath): string[] {
  return isBunTargetRuntime(execPath) ? ["--no-install"] : [];
}

/** The parent's reviewed compiler flags for an OpenClaw-owned Node child started now. */
export function resolveRuntimeCompilerArgs(execPath = process.execPath): string[] {
  return isBunTargetRuntime(execPath) ? [] : resolveForwardedNodeCompilerArgs();
}

/** Both launch policies for an OpenClaw-owned child started now. */
export function resolveRuntimeArgs(execPath = process.execPath): string[] {
  return [...resolveRuntimeInstallPolicyArgs(execPath), ...resolveRuntimeCompilerArgs(execPath)];
}

/** Whether a source TypeScript module needs Node's tsx loader; Bun runs TypeScript natively. */
export function runtimeNeedsTypeScriptLoader(modulePath: string, execPath = process.execPath) {
  return /\.[cm]?ts$/.test(modulePath) && !isBunTargetRuntime(execPath);
}

export function resolveRuntimeWorkerArgv(url: URL, execPath = process.execPath): string[] {
  const entry = fileURLToPath(url);
  // Resolve the preload here: Node resolves bare imports from the child cwd.
  const loader = runtimeNeedsTypeScriptLoader(entry, execPath)
    ? ["--import", import.meta.resolve("tsx")]
    : [];
  return [...resolveRuntimeArgs(execPath), ...loader, entry];
}

/** Self-hosted embedded entries use the image dispatcher; transferred scripts use Bun's runner. */
export function resolveRuntimeWorkerEnv(url: URL, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (isEmbeddedStandaloneModule(url.href)) {
    const embeddedEnv = { ...env };
    delete embeddedEnv.BUN_BE_BUN;
    return embeddedEnv;
  }
  return resolveRuntimeScriptEnv(env);
}

/** Select the source Worker preload without feeding Node's TypeScript loader to Bun. */
export function resolveRuntimeWorkerThreadExecArgv(
  url: URL,
  execPath = process.execPath,
): string[] {
  // Sealed runtimes contain compiled workers and must not retain source-loader assets.
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    return [];
  }
  return url.protocol === "file:" && runtimeNeedsTypeScriptLoader(fileURLToPath(url), execPath)
    ? ["--import", resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.workerThreadLoader).href]
    : [];
}
