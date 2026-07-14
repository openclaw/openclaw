// Prepares source-backed package update specs before global installation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import {
  isGitPackageInstallSpec,
  isLocalDirectoryPackageInstallSpec,
  npmGitPackSourceAccessArgs,
  npmPackageMetadataInstallSpec,
  npmSourceAccessArgs,
  pinGitPackageInstallSpec,
} from "./package-manager-install-policy.js";
import { validatePackageNodeEngine } from "./package-update-lifecycle.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

const NPM_PACK_FLAGS = ["--json", "--loglevel=error"] as const;
const NPM_PACK_WITHOUT_SCRIPTS_FLAGS = ["--ignore-scripts", ...NPM_PACK_FLAGS] as const;
const NPM_PACK_WITH_SCRIPTS_FLAGS = ["--ignore-scripts=false", ...NPM_PACK_FLAGS] as const;
const NPM_SOURCE_METADATA_FLAGS = ["--ignore-scripts", ...NPM_PACK_FLAGS] as const;
const IMMUTABLE_GIT_RESOLUTION_PATTERN = /#([a-f0-9]{40,64})(?=$|::)/iu;

function parseNpmSourceMetadata(stdout: string | null): {
  nodeEngine: string | null;
  resolved: string | null;
} {
  if (!stdout) {
    throw new Error("npm source metadata returned no JSON");
  }
  const parsed = JSON.parse(stdout) as unknown;
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const engines =
      record.engines && typeof record.engines === "object"
        ? (record.engines as Record<string, unknown>)
        : null;
    const nodeEngine = record["engines.node"] ?? engines?.node;
    const resolved = record._resolved;
    return {
      nodeEngine: typeof nodeEngine === "string" ? nodeEngine.trim() || null : null,
      resolved: typeof resolved === "string" ? resolved.trim() || null : null,
    };
  }
  throw new Error("npm source metadata JSON did not contain a package record");
}

async function findPackedTarball(packDir: string): Promise<string | null> {
  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    return null;
  }
  return path.join(packDir, tarballs[0] ?? "");
}

export async function preparePackedPackageInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  runtimeVersion: string | null;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  forcePack?: boolean;
  packCommandArgv?: readonly string[] | null;
}): Promise<{
  installSpec: string;
  packDir: string | null;
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  const isGitSource = isGitPackageInstallSpec(params.packageName, params.installSpec);
  const isNpmSource =
    params.installTarget.manager === "npm" &&
    (isGitSource || isLocalDirectoryPackageInstallSpec(params.packageName, params.installSpec));
  const shouldPack = params.forcePack === true || isNpmSource;
  if (!shouldPack) {
    return { installSpec: params.installSpec, packDir: null, steps: [], failedStep: null };
  }

  const packCommandArgv =
    params.packCommandArgv !== undefined
      ? params.packCommandArgv
      : params.installTarget.manager === "npm"
        ? [params.installTarget.command]
        : null;
  if (!packCommandArgv?.length) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack preflight",
      command: "resolve npm for selected Node",
      cwd: params.installCwd ?? process.cwd(),
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "could not resolve an npm CLI for the selected managed-service Node",
    };
    return {
      installSpec: params.installSpec,
      packDir: null,
      steps: [failedStep],
      failedStep,
    };
  }
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  const steps: PackageUpdateStepResult[] = [];
  let packInstallSpec = params.installSpec;
  const runPack = async (
    name: string,
    installSpec: string,
    flags: readonly string[],
  ): Promise<PackageUpdateStepResult> =>
    params.runStep({
      name,
      argv: [
        ...packCommandArgv,
        "pack",
        installSpec,
        ...(isGitSource
          ? npmGitPackSourceAccessArgs(params.packageName, installSpec)
          : npmSourceAccessArgs(params.packageName, installSpec)),
        "--pack-destination",
        packDir,
        ...flags,
      ],
      cwd: params.installCwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });

  if (isNpmSource) {
    // npm 10 can run prepare during `pack --ignore-scripts`. This metadata probe
    // avoids lifecycle execution, then pins the later Git pack to its resolved SHA.
    // npm 12 honors the explicit false below after Git access approves the source.
    const metadataInstallSpec = npmPackageMetadataInstallSpec(
      params.packageName,
      params.installSpec,
    );
    const metadataStep = await params.runStep({
      name: "global update source metadata",
      argv: [
        ...packCommandArgv,
        "view",
        metadataInstallSpec,
        "engines.node",
        "_resolved",
        ...npmSourceAccessArgs(params.packageName, params.installSpec),
        ...NPM_SOURCE_METADATA_FLAGS,
      ],
      cwd: params.installCwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
    const metadataOutput = metadataStep.stdoutTail;
    steps.push({
      ...metadataStep,
      stdoutTail:
        metadataStep.exitCode === 0
          ? "resolved source metadata without running lifecycle scripts"
          : null,
    });
    if (metadataStep.exitCode !== 0) {
      return {
        installSpec: params.installSpec,
        packDir,
        steps,
        failedStep: steps.at(-1) ?? metadataStep,
      };
    }

    const guardStartedAt = Date.now();
    let sourceGuardStep: PackageUpdateStepResult;
    try {
      const metadata = parseNpmSourceMetadata(metadataOutput ?? null);
      validatePackageNodeEngine(metadata.nodeEngine, params.runtimeVersion);
      if (isGitSource) {
        const commit = metadata.resolved?.match(IMMUTABLE_GIT_RESOLUTION_PATTERN)?.[1] ?? null;
        const pinned = commit
          ? pinGitPackageInstallSpec(params.packageName, params.installSpec, commit)
          : null;
        if (!pinned) {
          throw new Error("npm source metadata did not resolve an immutable Git commit");
        }
        packInstallSpec = pinned;
      }
      sourceGuardStep = {
        name: "global update source runtime guard",
        command: `validate npm source metadata engines.node`,
        cwd: params.installCwd ?? process.cwd(),
        durationMs: Date.now() - guardStartedAt,
        exitCode: 0,
        stdoutTail: `validated Node ${params.runtimeVersion} against ${metadata.nodeEngine}`,
        stderrTail: null,
      };
    } catch (error) {
      sourceGuardStep = {
        name: "global update source runtime guard",
        command: `validate npm source metadata engines.node`,
        cwd: params.installCwd ?? process.cwd(),
        durationMs: Date.now() - guardStartedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(error),
      };
    }
    steps.push(sourceGuardStep);
    if (sourceGuardStep.exitCode !== 0) {
      return {
        installSpec: params.installSpec,
        packDir,
        steps,
        failedStep: sourceGuardStep,
      };
    }
  }

  const packStep = await runPack(
    "global update pack",
    packInstallSpec,
    isNpmSource ? NPM_PACK_WITH_SCRIPTS_FLAGS : NPM_PACK_WITHOUT_SCRIPTS_FLAGS,
  );
  steps.push(packStep);
  if (packStep.exitCode !== 0) {
    return {
      installSpec: params.installSpec,
      packDir,
      steps,
      failedStep: packStep,
    };
  }

  const tarball = await findPackedTarball(packDir);
  if (!tarball) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from ${packCommandArgv.join(" ")} pack ${params.installSpec}`,
    };
    return {
      installSpec: params.installSpec,
      packDir,
      steps: [...steps, failedStep],
      failedStep,
    };
  }

  return {
    installSpec: tarball,
    packDir,
    steps,
    failedStep: null,
  };
}
