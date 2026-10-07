import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PackageUpdateStepRunner } from "./package-update-lifecycle.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

function isNpmGitSourceInstallSpec(spec: string, packageName: string): boolean {
  const trimmed = spec.trim();
  const prefix = `${packageName.trim()}@`;
  const target = trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length).trim()
    : trimmed;
  if (
    /^github:/i.test(target) ||
    /^git\+(?:ssh|https|http|file):/i.test(target) ||
    /^git:/i.test(target) ||
    /^ssh:\/\//i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target)
  ) {
    return true;
  }
  const url = URL.parse(target);
  if (url && (url.protocol === "https:" || url.protocol === "http:")) {
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (
      pathname.endsWith(".git") ||
      (url.hostname.toLowerCase() === "github.com" &&
        pathname.split("/").filter(Boolean).length === 2)
    ) {
      return true;
    }
  }
  const [repo] = target.split("#", 1);
  if (!repo || repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("@")) {
    return false;
  }
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[^\s/:@]+$/u.test(part));
}

type PreparedNpmInstallSpec = {
  installSpec: string;
  installCwd: string | null;
  packDir: string | null;
  steps: UpdateStepResult[];
  failedStep: UpdateStepResult | null;
};

export async function prepareNpmGitSourceInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
}): Promise<PreparedNpmInstallSpec> {
  const result: PreparedNpmInstallSpec = {
    installSpec: params.installSpec,
    installCwd: params.installCwd ?? null,
    packDir: null,
    steps: [],
    failedStep: null,
  };
  if (
    params.installTarget.manager !== "npm" ||
    !isNpmGitSourceInstallSpec(params.installSpec, params.packageName)
  ) {
    return result;
  }

  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  result.packDir = packDir;
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
  result.steps.push(packStep);
  if (isFailedUpdateStep(packStep)) {
    result.failedStep = packStep;
    return result;
  }

  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    const failedStep: UpdateStepResult = {
      name: "package-pack-verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from npm pack ${params.installSpec}`,
    };
    result.steps.push(failedStep);
    result.failedStep = failedStep;
    return result;
  }

  result.installSpec = path.join(packDir, tarballs[0] ?? "");
  result.installCwd = packDir;
  return result;
}
