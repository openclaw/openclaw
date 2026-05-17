import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRASH_DESTINATION_COLLISION_CODES = new Set(["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;

export type MovePathToTrashOptions = {
  allowedRoots?: string[];
};

type PathApi = typeof path.posix | typeof path.win32;

function getFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isTrashDestinationCollision(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}

function isLikelyWindowsPath(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  if (value.startsWith("\\\\")) {
    return true;
  }
  if (value.includes("\\")) {
    return true;
  }
  return false;
}

function resolvePathApi(targetPath: string, allowedRoots: readonly string[]): PathApi {
  const samples = [targetPath, ...allowedRoots, os.homedir(), os.tmpdir()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (samples.some(isLikelyWindowsPath)) {
    return path.win32;
  }
  return path.posix;
}

function resolveAbsolute(pathApi: PathApi, filePath: string): string {
  try {
    return pathApi.resolve(fs.realpathSync.native(filePath));
  } catch {
    return pathApi.resolve(filePath);
  }
}

function isSameOrChildPath(pathApi: PathApi, candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${pathApi.sep}`);
}

function resolveAllowedTrashRoots(pathApi: PathApi, allowedRoots?: readonly string[]): string[] {
  const roots = [...(allowedRoots ?? [os.homedir(), os.tmpdir()])]
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => resolveAbsolute(pathApi, root));
  return [...new Set(roots)];
}

function assertAllowedTrashTarget(
  pathApi: PathApi,
  targetPath: string,
  allowedRoots?: readonly string[],
): void {
  const resolvedTargetPath = resolveAbsolute(pathApi, targetPath);
  const isAllowed = resolveAllowedTrashRoots(pathApi, allowedRoots).some(
    (root) => resolvedTargetPath !== root && isSameOrChildPath(pathApi, resolvedTargetPath, root),
  );
  if (!isAllowed) {
    throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
  }
}

function resolveTrashDir(pathApi: PathApi): string {
  const homeDir = os.homedir();
  const trashDir = pathApi.join(homeDir, ".Trash");
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });

  const trashDirStat = fs.lstatSync(trashDir);
  if (!trashDirStat.isDirectory() || trashDirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory/symlink trash directory: ${trashDir}`);
  }

  const realHome = resolveAbsolute(pathApi, homeDir);
  const resolvedTrashDir = resolveAbsolute(pathApi, trashDir);
  if (resolvedTrashDir === realHome || !isSameOrChildPath(pathApi, resolvedTrashDir, realHome)) {
    throw new Error(`Trash directory escaped home directory: ${trashDir}`);
  }
  return resolvedTrashDir;
}

function trashBaseName(pathApi: PathApi, targetPath: string): string {
  const resolvedTargetPath = pathApi.resolve(targetPath);
  if (resolvedTargetPath === pathApi.parse(resolvedTargetPath).root) {
    throw new Error(`Refusing to trash root path: ${targetPath}`);
  }
  const base = pathApi.basename(resolvedTargetPath).replace(/[\\/]+/g, "");
  if (!base) {
    throw new Error(`Unable to derive safe trash basename for: ${targetPath}`);
  }
  return base;
}

function resolveContainedPath(pathApi: PathApi, root: string, leaf: string): string {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedPath = pathApi.resolve(resolvedRoot, leaf);
  if (!isSameOrChildPath(pathApi, resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    throw new Error(`Trash destination escaped trash directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function reserveTrashDestination(
  pathApi: PathApi,
  trashDir: string,
  base: string,
  timestamp: number,
) {
  const containerPrefix = resolveContainedPath(pathApi, trashDir, `${base}-${timestamp}-`);
  const container = fs.mkdtempSync(containerPrefix);
  const resolvedContainer = pathApi.resolve(container);
  const resolvedTrashDir = pathApi.resolve(trashDir);
  if (
    resolvedContainer === resolvedTrashDir ||
    !isSameOrChildPath(pathApi, resolvedContainer, resolvedTrashDir)
  ) {
    throw new Error(`Trash destination escaped trash directory: ${container}`);
  }
  return resolveContainedPath(pathApi, container, base);
}

function movePathToDestination(targetPath: string, dest: string): boolean {
  try {
    fs.renameSync(targetPath, dest);
    return true;
  } catch (error) {
    if (getFsErrorCode(error) !== "EXDEV") {
      if (isTrashDestinationCollision(error)) {
        return false;
      }
      throw error;
    }
  }

  try {
    fs.cpSync(targetPath, dest, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(targetPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isTrashDestinationCollision(error)) {
      return false;
    }
    throw error;
  }
}

export async function movePathToTrash(
  targetPath: string,
  options: MovePathToTrashOptions = {},
): Promise<string> {
  const pathApi = resolvePathApi(targetPath, options.allowedRoots ?? []);
  const base = trashBaseName(pathApi, targetPath);
  assertAllowedTrashTarget(pathApi, targetPath, options.allowedRoots);
  const trashDir = resolveTrashDir(pathApi);
  const timestamp = Date.now();

  for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
    const dest = reserveTrashDestination(pathApi, trashDir, base, timestamp);
    if (movePathToDestination(targetPath, dest)) {
      return dest;
    }
  }

  throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
