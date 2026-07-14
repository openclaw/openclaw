import fs from "node:fs/promises";
import path from "node:path";
import {
  probePackageCliNodeRuntime,
  type PackageCliNodeRuntime,
} from "../../scripts/preinstall-package-manager-warning.mjs";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import { nodeVersionSatisfiesEngine } from "./runtime-guard.js";
import type { CommandRunner } from "./update-global.js";

const PACKAGE_PREINSTALL_COMMAND = "node scripts/preinstall-package-manager-warning.mjs";
const PACKAGE_POSTINSTALL_RELATIVE_PATH = "scripts/postinstall-bundled-plugins.mjs";
const PACKAGE_POSTINSTALL_COMMAND = `node ${PACKAGE_POSTINSTALL_RELATIVE_PATH}`;
const PACKAGE_PREPARE_COMMAND = "node scripts/prepare-git-hooks.mjs";

// Staging replaces preinstall with the runtime guard below and skips the checkout-only prepare.
// Reject any hook drift before swap instead of activating a partially initialized package.
const PACKAGE_LIFECYCLE_CONTRACT = {
  preinstall: PACKAGE_PREINSTALL_COMMAND,
  install: null,
  postinstall: PACKAGE_POSTINSTALL_COMMAND,
  prepare: PACKAGE_PREPARE_COMMAND,
} as const;

/** Probes the Node selected for the updated install; managed services may not use process.execPath. */
export async function resolvePackageRuntime(params: {
  nodePath?: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  probeNodeRuntime?: typeof probePackageCliNodeRuntime;
}): Promise<{ nodePath: string | null; version: string | null }> {
  if (!params.nodePath && !process.versions.bun) {
    return { nodePath: process.execPath, version: process.versions.node ?? null };
  }
  if (!params.nodePath) {
    const env = params.env ?? process.env;
    const runtime = (params.probeNodeRuntime ?? probePackageCliNodeRuntime)({
      pathEnv: env.PATH ?? env.Path ?? "",
      cwd: params.cwd ?? process.cwd(),
    });
    return normalizePackageCliNodeRuntime(runtime);
  }
  const result = await params
    .runCommand([params.nodePath, "--version"], {
      timeoutMs: Math.min(params.timeoutMs, 10_000),
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.env === undefined ? {} : { env: params.env }),
    })
    .catch(() => null);
  return {
    nodePath: params.nodePath,
    version: result?.code === 0 ? result.stdout.trim().replace(/^v/u, "") || null : null,
  };
}

function normalizePackageCliNodeRuntime(runtime: PackageCliNodeRuntime | null): {
  nodePath: string | null;
  version: string | null;
} {
  if (!runtime || runtime.bunVersion || !runtime.execPath || !runtime.version) {
    return { nodePath: null, version: null };
  }
  return { nodePath: runtime.execPath, version: runtime.version };
}

async function readCandidatePackageContract(packageRoot: string): Promise<{
  nodeEngine: string | null;
  preinstall: string | null;
  install: string | null;
  postinstall: string | null;
  prepare: string | null;
}> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    engines?: { node?: unknown };
    scripts?: Record<string, unknown>;
  };
  const lifecycleCommand = (name: keyof typeof PACKAGE_LIFECYCLE_CONTRACT): string | null => {
    const value = manifest.scripts?.[name];
    return typeof value === "string" ? value.trim() || null : null;
  };
  return {
    nodeEngine:
      typeof manifest.engines?.node === "string" ? manifest.engines.node.trim() || null : null,
    preinstall: lifecycleCommand("preinstall"),
    install: lifecycleCommand("install"),
    postinstall: lifecycleCommand("postinstall"),
    prepare: lifecycleCommand("prepare"),
  };
}

/** Validates a guarded candidate without executing package-manager lifecycle code. */
export async function runPackageRuntimeGuard(
  packageRoot: string,
  runtimeVersion: string | null = process.versions.node ?? null,
  name = "global install runtime guard",
): Promise<PackageUpdateStepResult> {
  const markerPath = path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
  const startedAt = Date.now();
  try {
    if (!(await pathExists(markerPath))) {
      throw new Error("staged package is missing its package install guard");
    }
    const contract = await readCandidatePackageContract(packageRoot);
    const engine = contract.nodeEngine;
    const satisfied = nodeVersionSatisfiesEngine(runtimeVersion, engine);
    if (satisfied !== true) {
      const requirement = engine
        ? `this OpenClaw release requires Node ${engine}`
        : "could not read this OpenClaw release's Node requirement";
      throw new Error(
        `${requirement}; detected Node ${runtimeVersion ?? "missing"}. Upgrade Node, then retry the OpenClaw update.`,
      );
    }
    for (const [name, expected] of Object.entries(PACKAGE_LIFECYCLE_CONTRACT)) {
      const actual = contract[name as keyof typeof PACKAGE_LIFECYCLE_CONTRACT];
      if (actual !== expected) {
        throw new Error(
          `staged package declares unsupported ${name} contract ${JSON.stringify(actual)}`,
        );
      }
    }
    if (!(await pathExists(path.join(packageRoot, PACKAGE_POSTINSTALL_RELATIVE_PATH)))) {
      throw new Error(`staged package is missing ${PACKAGE_POSTINSTALL_RELATIVE_PATH}`);
    }
    await fs.rm(markerPath, { force: true });
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: `validated Node ${runtimeVersion} against ${engine}`,
      stderrTail: null,
    };
  } catch (error) {
    return {
      name,
      command: `validate ${path.join(packageRoot, "package.json")} engines.node`,
      cwd: packageRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(error),
    };
  }
}

/** Runs only OpenClaw's package-root postinstall after dependency scripts stayed disabled. */
export async function runPackagePostinstall(params: {
  packageRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}): Promise<PackageUpdateStepResult> {
  const scriptPath = path.join(params.packageRoot, PACKAGE_POSTINSTALL_RELATIVE_PATH);
  const nodePath = params.nodePath?.trim() || (!process.versions.bun ? process.execPath : null);
  if (!nodePath) {
    return {
      name: "global install postinstall",
      command: `run ${scriptPath}`,
      cwd: params.packageRoot,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "could not resolve the real Node runtime for staged package postinstall",
    };
  }
  return params.runStep({
    name: "global install postinstall",
    argv: [nodePath, scriptPath],
    cwd: params.packageRoot,
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
}

export async function runStagedPackageLifecycle(params: {
  packageRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runtimeVersion?: string | null;
  nodePath?: string;
}): Promise<{
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  const guardStep = await runPackageRuntimeGuard(
    params.packageRoot,
    params.runtimeVersion === undefined ? (process.versions.node ?? null) : params.runtimeVersion,
  );
  if (guardStep.exitCode !== 0) {
    return { steps: [guardStep], failedStep: guardStep };
  }
  const postinstallStep = await runPackagePostinstall(params);
  return {
    steps: [guardStep, postinstallStep],
    failedStep: postinstallStep.exitCode === 0 ? null : postinstallStep,
  };
}
