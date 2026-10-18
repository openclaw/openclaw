// Private QA CLI loader, enabled only from source checkouts and explicit env opt-in.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const PRIVATE_QA_DIST_RELATIVE_PATH = path.join("dist", "plugin-sdk", "qa-lab.js");
const SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS = [".git", "pnpm-workspace.yaml"] as const;

/** Return true when private QA CLI routes should be exposed. */
export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function resolvePrivateQaSourceModuleSpecifier(): string | null {
  if (!isPrivateQaCliEnabled()) {
    return null;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (!packageRoot) {
    return null;
  }
  const sourceModulePath = path.join(packageRoot, PRIVATE_QA_DIST_RELATIVE_PATH);
  const hasSourceCheckoutMarker = SOURCE_CHECKOUT_MARKER_RELATIVE_PATHS.some((relativePath) =>
    fs.existsSync(path.join(packageRoot, relativePath)),
  );
  if (
    !hasSourceCheckoutMarker ||
    !fs.existsSync(path.join(packageRoot, "src")) ||
    !fs.existsSync(sourceModulePath)
  ) {
    return null;
  }
  return pathToFileURL(sourceModulePath).href;
}

/** Load the private QA module from a source checkout or throw a user-facing availability error. */
export function loadPrivateQaCliModule(): Promise<Record<string, unknown>> {
  const specifier = resolvePrivateQaSourceModuleSpecifier();
  if (!specifier) {
    throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
  }
  return import(specifier);
}
