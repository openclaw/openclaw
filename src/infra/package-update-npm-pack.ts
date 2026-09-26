import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PackageUpdateStepRunner } from "./package-update-lifecycle.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

function stripPackageAlias(spec: string, packageName: string): string {
  const trimmed = spec.trim();
  const prefix = `${packageName.trim()}@`;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length).trim()
    : trimmed;
}

function isHttpGitUrlSpec(spec: string): boolean {
  try {
    const url = new URL(spec);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.endsWith(".git")) {
      return true;
    }
    const parts = pathname.split("/").filter(Boolean);
    return url.hostname.toLowerCase() === "github.com" && parts.length === 2;
  } catch {
    return false;
  }
}

function isGitHubShorthandSpec(spec: string): boolean {
  const [repo] = spec.split("#", 1);
  if (!repo || repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("@")) {
    return false;
  }
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[^\s/:@]+$/u.test(part));
}

function isNpmGitSourceInstallSpec(spec: string, packageName: string): boolean {
  const target = stripPackageAlias(spec, packageName);
  return (
    /^github:/i.test(target) ||
    /^git\+(?:ssh|https|http|file):/i.test(target) ||
    /^git:/i.test(target) ||
    /^ssh:\/\//i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
    isHttpGitUrlSpec(target) ||
    isGitHubShorthandSpec(target)
  );
}

async function findPackedTarball(packDir: string): Promise<string | null> {
  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    return null;
  }
  return path.join(packDir, tarballs[0] ?? "");
}

export async function prepareNpmGitSourceInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
}): Promise<{
  installSpec: string;
  installCwd: string | null;
  packDir: string | null;
  steps: UpdateStepResult[];
  failedStep: UpdateStepResult | null;
}> {
  if (
    params.installTarget.manager !== "npm" ||
    !isNpmGitSourceInstallSpec(params.installSpec, params.packageName)
  ) {
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir: null,
      steps: [],
      failedStep: null,
    };
  }

  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  const packStep = await params.runStep({
    name: "package-pack",
    argv: [
      params.installTarget.command,
      "pack",
      params.installSpec,
      "--pack-destination",
      packDir,
      ...NPM_PACK_QUIET_FLAGS,
    ],
    cwd: params.installCwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });
  if (isFailedUpdateStep(packStep)) {
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir,
      steps: [packStep],
      failedStep: packStep,
    };
  }

  const tarball = await findPackedTarball(packDir);
  if (!tarball) {
    const failedStep: UpdateStepResult = {
      name: "package-pack-verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from npm pack ${params.installSpec}`,
    };
    return {
      installSpec: params.installSpec,
      installCwd: params.installCwd ?? null,
      packDir,
      steps: [packStep, failedStep],
      failedStep,
    };
  }

  return {
    installSpec: tarball,
    installCwd: packDir,
    packDir,
    steps: [packStep],
    failedStep: null,
  };
}
