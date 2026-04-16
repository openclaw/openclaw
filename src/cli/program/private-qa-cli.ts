import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const PRIVATE_QA_DIST_RELATIVE_PATH = path.join("dist", "plugin-sdk", "qa-lab.js");
const PRIVATE_QA_RUNTIME_SPECIFIERS = [
  "../../plugin-sdk/qa-lab.js",
  "./plugin-sdk/qa-lab.js",
  "../../../dist/plugin-sdk/qa-lab.js",
] as const;

type PrivateQaCliModule = Record<string, unknown>;

type LoadPrivateQaCliModuleParams = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
  resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
  existsSync?: typeof fs.existsSync;
  importModule?: (specifier: string) => Promise<PrivateQaCliModule>;
};

function usesExplicitPrivateQaResolutionParams(
  params?: LoadPrivateQaCliModuleParams,
): params is LoadPrivateQaCliModuleParams {
  return Boolean(params && Object.keys(params).length > 0);
}

export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function isModuleNotFoundError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";
}

function resolvePrivateQaSourceModuleSpecifier(params?: LoadPrivateQaCliModuleParams): string | null {
  const env = params?.env ?? process.env;
  if (!isPrivateQaCliEnabled(env)) {
    return null;
  }
  const resolvePackageRootSync = params?.resolvePackageRootSync ?? resolveOpenClawPackageRootSync;
  const packageRoot = resolvePackageRootSync({
    argv1: params?.argv1 ?? process.argv[1],
    cwd: params?.cwd ?? process.cwd(),
    moduleUrl: params?.moduleUrl ?? import.meta.url,
  });
  if (!packageRoot) {
    return null;
  }
  const existsSync = params?.existsSync ?? fs.existsSync;
  const sourceModulePath = path.join(packageRoot, PRIVATE_QA_DIST_RELATIVE_PATH);
  if (
    !existsSync(path.join(packageRoot, ".git")) ||
    !existsSync(path.join(packageRoot, "src")) ||
    !existsSync(sourceModulePath)
  ) {
    return null;
  }
  return pathToFileURL(sourceModulePath).href;
}

async function dynamicImportPrivateQaCliModule(specifier: string): Promise<PrivateQaCliModule> {
  return (await import(specifier)) as PrivateQaCliModule;
}

export function loadPrivateQaCliModule(
  params?: LoadPrivateQaCliModuleParams,
): Promise<PrivateQaCliModule> {
  const importModule = params?.importModule ?? dynamicImportPrivateQaCliModule;
  const sourceSpecifier = resolvePrivateQaSourceModuleSpecifier(params);
  if (sourceSpecifier) {
    return importModule(sourceSpecifier);
  }

  if (usesExplicitPrivateQaResolutionParams(params)) {
    throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
  }

  return (async () => {
    let lastNotFoundError: unknown;
    for (const specifier of PRIVATE_QA_RUNTIME_SPECIFIERS) {
      try {
        return await importModule(specifier);
      } catch (err) {
        if (isModuleNotFoundError(err)) {
          lastNotFoundError = err;
          continue;
        }
        throw err;
      }
    }

    throw (
      lastNotFoundError ??
      new Error("Unable to resolve the private QA CLI module from any known runtime location.")
    );
  })();
}
