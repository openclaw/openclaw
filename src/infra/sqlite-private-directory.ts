// Creates private SQLite staging directories without pulling higher-level runtime modules.
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import { markPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import {
  hasSqliteSnapshotCapacityCode,
  SqliteSnapshotCapacityError,
} from "./sqlite-snapshot-capacity-error.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createPrivateWindowsDirectory } from "./windows-private-directory.js";

const SQLITE_DIRECTORY_MODE = 0o700;

export async function createPrivateSqliteDirectory(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(directoryPath, { mode: SQLITE_DIRECTORY_MODE });
    return;
  }
  createPrivateWindowsDirectory(directoryPath);
}

export function resolvePrivateSqliteSnapshotStagingRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return resolveSnapshotStagingRoot(env);
  } catch (error) {
    // Only root allocation capacity is disposable; admission and permissions stay blocking.
    if (error instanceof Error && hasSqliteSnapshotCapacityCode(error)) {
      throw new SqliteSnapshotCapacityError(
        `SQLite snapshot staging root is unavailable: ${error.message}; free disk space/quota`,
        { cause: error },
      );
    }
    throw error;
  }
}

function resolveSnapshotStagingRoot(env: NodeJS.ProcessEnv): string {
  // Shipped update drivers already give their candidate helpers a private TMPDIR.
  // Keep disposable inspection images there, not beside retained recovery backups.
  const updateTmp = env.OPENCLAW_UPDATE_IN_PROGRESS === "1" ? env.TMPDIR?.trim() : undefined;
  if (updateTmp && path.isAbsolute(updateTmp)) {
    return resolvePreferredOpenClawTmpDir({
      preferredDir: path.join(updateTmp, "openclaw"),
      tmpdir: () => updateTmp,
    });
  }
  const appData = process.platform === "win32" ? env.LOCALAPPDATA?.trim() : undefined;
  const defaultRoot = process.platform === "win32" ? "AppData/Local" : ".cache";
  const platformRoot = process.platform === "darwin" ? "Library/Caches" : defaultRoot;
  const cacheRoot =
    [env.XDG_CACHE_HOME?.trim(), appData].find((root) => root && path.isAbsolute(root)) ??
    path.join(resolveRequiredOsHomeDir(env), platformRoot);
  // Cache roots can serve several installations. Only this namespace is eligible
  // for automatic retirement; older shared-cache staging remains operator-owned.
  const stateDir = resolveStateDir(env);
  const installation = createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
  // Admission needs the preferred root's parent; otherwise only the first
  // allocation falls back and its abandoned copies disappear from later sweeps.
  fsSync.mkdirSync(cacheRoot, { recursive: true, mode: SQLITE_DIRECTORY_MODE });
  const admittedRoot = resolvePreferredOpenClawTmpDir({
    preferredDir: path.join(cacheRoot, "openclaw"),
    tmpdir: () => cacheRoot,
  });
  // Doctor inspects a private state copy staged in its installation's namespace.
  // Copies taken through it stay there, where that installation's sweep finds them.
  const [enclosing = "", ...inside] = path.relative(admittedRoot, stateDir).split(path.sep);
  const namespace =
    inside.length > 0 && /^sqlite-[a-f0-9]{24}$/u.test(enclosing)
      ? enclosing
      : `sqlite-${installation}`;
  // Apply the namespace after root admission, including Windows and safe fallbacks.
  const directory = path.join(admittedRoot, namespace);
  fsSync.mkdirSync(directory, { recursive: true, mode: SQLITE_DIRECTORY_MODE });
  const stat = fsSync.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("SQLite snapshot namespace must be a private user-owned directory");
  }
  return directory;
}

export async function createPrivateSqliteTempDirectory(
  rootPath: string,
  prefix: string,
): Promise<string> {
  if (process.platform !== "win32") {
    return await fs.mkdtemp(path.join(rootPath, prefix));
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  await createPrivateSqliteDirectory(directoryPath);
  return directoryPath;
}

export function createPrivateSqliteTempDirectorySync(rootPath: string, prefix: string): string {
  if (process.platform !== "win32") {
    try {
      return fsSync.mkdtempSync(path.join(rootPath, prefix));
    } catch (error) {
      throw markPrivateDirectoryCreationRefused(error);
    }
  }
  const directoryPath = path.join(rootPath, `${prefix}${randomUUID()}`);
  createPrivateWindowsDirectory(directoryPath);
  return directoryPath;
}
