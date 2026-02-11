import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";

export type ArchiveKind = "tar" | "zip";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

const TAR_SUFFIXES = [".tgz", ".tar.gz", ".tar"];

export function resolveArchiveKind(filePath: string): ArchiveKind | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return "tar";
  }
  return null;
}

export async function resolvePackedRootDir(extractDir: string): Promise<string> {
  const direct = path.join(extractDir, "package");
  try {
    const stat = await fs.stat(direct);
    if (stat.isDirectory()) {
      return direct;
    }
  } catch {
    // ignore
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length !== 1) {
    throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
  }
  const onlyDir = dirs[0];
  if (!onlyDir) {
    throw new Error("unexpected archive layout (no package dir found)");
  }
  return path.join(extractDir, onlyDir);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function extractZip(params: { archivePath: string; destDir: string }): Promise<void> {
  const buffer = await fs.readFile(params.archivePath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    const entryPath = entry.name.replaceAll("\\", "/");
    if (!entryPath || entryPath.endsWith("/")) {
      const dirPath = path.resolve(params.destDir, entryPath);
      if (!dirPath.startsWith(params.destDir)) {
        throw new Error(`zip entry escapes destination: ${entry.name}`);
      }
      await fs.mkdir(dirPath, { recursive: true });
      continue;
    }

    const outPath = path.resolve(params.destDir, entryPath);
    if (!outPath.startsWith(params.destDir)) {
      throw new Error(`zip entry escapes destination: ${entry.name}`);
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const data = await entry.async("nodebuffer");
    await fs.writeFile(outPath, data);
  }
}

export async function extractArchive(params: {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  logger?: ArchiveLogger;
}): Promise<void> {
  const kind = resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    const destDir = params.destDir;
    await withTimeout(
      tar.x({
        file: params.archivePath,
        cwd: destDir,
        filter: (entryPath) => {
          const resolved = path.resolve(destDir, entryPath);
          if (!resolved.startsWith(destDir + path.sep) && resolved !== destDir) {
            return false;
          }
          return true;
        },
      }),
      params.timeoutMs,
      label,
    );
    return;
  }

  await withTimeout(extractZip(params), params.timeoutMs, label);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
