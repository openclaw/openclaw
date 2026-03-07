import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sanitizeManifestForNpmInstall(targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  let manifestRaw = "";
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestRaw) as unknown;
    if (!isObjectRecord(parsed)) {
      return;
    }
    manifest = parsed;
  } catch {
    return;
  }

  const devDependencies = manifest.devDependencies;
  if (!isObjectRecord(devDependencies)) {
    return;
  }

  const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    return !spec.startsWith("workspace:");
  });
  if (filteredEntries.length === Object.keys(devDependencies).length) {
    return;
  }

  if (filteredEntries.length === 0) {
    delete manifest.devDependencies;
  } else {
    manifest.devDependencies = Object.fromEntries(filteredEntries);
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

async function assertInstallBoundaryPaths(params: {
  installBaseDir: string;
  candidatePaths: string[];
}): Promise<void> {
  for (const candidatePath of params.candidatePaths) {
    await assertCanonicalPathWithinBase({
      baseDir: params.installBaseDir,
      candidatePath,
      boundaryLabel: "install directory",
    });
  }
}

function isRelativePathInsideBase(relativePath: string): boolean {
  return (
    Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)
  );
}

async function assertInstallBaseStable(params: {
  installBaseDir: string;
  expectedRealPath: string;
}): Promise<void> {
  const baseLstat = await fs.lstat(params.installBaseDir);
  if (!baseLstat.isDirectory() || baseLstat.isSymbolicLink()) {
    throw new Error("install base directory changed during install");
  }
  const currentRealPath = await fs.realpath(params.installBaseDir);
  if (currentRealPath !== params.expectedRealPath) {
    throw new Error("install base directory changed during install");
  }
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  await fs.mkdir(installBaseDir, { recursive: true });
  await assertInstallBoundaryPaths({
    installBaseDir,
    candidatePaths: [params.targetDir],
  });
  const installBaseResolved = path.resolve(installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (!isRelativePathInsideBase(targetRelativePath)) {
    return { ok: false, error: `${params.copyErrorPrefix}: Error: invalid install target path` };
  }
  const installBaseRealPath = await fs.realpath(installBaseDir);
  const canonicalTargetDir = path.join(installBaseRealPath, targetRelativePath);

  let stageDir: string | null = null;
  let backupDir: string | null = null;
  const fail = async (error: string) => {
    await restoreBackup();
    if (stageDir) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      stageDir = null;
    }
    return { ok: false as const, error };
  };
  const restoreBackup = async () => {
    if (!backupDir) {
      return;
    }
    await fs.rename(backupDir, canonicalTargetDir).catch(() => undefined);
    backupDir = null;
  };

  try {
    await assertInstallBoundaryPaths({
      installBaseDir: installBaseRealPath,
      candidatePaths: [canonicalTargetDir],
    });
    stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
    await fs.cp(params.sourceDir, stageDir, { recursive: true });
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`);
  }

  try {
    await params.afterCopy?.(stageDir);
  } catch (err) {
    return await fail(`post-copy validation failed: ${String(err)}`);
  }

  if (params.hasDeps) {
    await sanitizeManifestForNpmInstall(stageDir);
    params.logger?.info?.(params.depsLogMessage);
    const npmRes = await runCommandWithTimeout(
      ["npm", "install", "--omit=dev", "--omit=peer", "--silent", "--ignore-scripts"],
      {
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        cwd: stageDir,
      },
    );
    if (npmRes.code !== 0) {
      return await fail(`npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`);
    }
  }

  if (params.mode === "update" && (await fileExists(canonicalTargetDir))) {
    const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
    backupDir = path.join(backupRoot, `${path.basename(canonicalTargetDir)}-${Date.now()}`);
    try {
      await fs.mkdir(backupRoot, { recursive: true });
      await assertInstallBoundaryPaths({
        installBaseDir: installBaseRealPath,
        candidatePaths: [backupDir],
      });
      await assertInstallBaseStable({
        installBaseDir,
        expectedRealPath: installBaseRealPath,
      });
      await fs.rename(canonicalTargetDir, backupDir);
    } catch (err) {
      return await fail(`${params.copyErrorPrefix}: ${String(err)}`);
    }
  }

  try {
    await assertInstallBaseStable({
      installBaseDir,
      expectedRealPath: installBaseRealPath,
    });
    await fs.rename(stageDir, canonicalTargetDir);
    stageDir = null;
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`);
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (stageDir) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true };
}

export async function installPackageDirWithManifestDeps(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  depsLogMessage: string;
  manifestDependencies?: Record<string, unknown>;
  afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return installPackageDir({
    ...params,
    hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0,
  });
}
