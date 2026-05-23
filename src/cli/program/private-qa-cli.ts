import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const PRIVATE_QA_DIST_RELATIVE_PATH = path.join("dist", "plugin-sdk", "qa-lab.js");
const SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS = [".git", "pnpm-workspace.yaml"] as const;

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

export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
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
  const hasSourceCheckoutMarker = SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS.some((relativePath) =>
    existsSync(path.join(packageRoot, relativePath)),
  );
  if (
    !hasSourceCheckoutMarker ||
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
  const sourceSpecifier = resolvePrivateQaSourceModuleSpecifier(params);
  if (!sourceSpecifier) {
    throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
  }
  return (params?.importModule ?? dynamicImportPrivateQaCliModule)(sourceSpecifier);
}
