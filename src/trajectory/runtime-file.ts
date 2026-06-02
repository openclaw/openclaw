import fsp from "node:fs/promises";
import path from "node:path";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  safeTrajectorySessionFileName,
} from "./paths.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Confirms a candidate runtime file is a regular file and not a swapped symlink. */
export async function isRegularNonSymlinkFile(filePath: string): Promise<boolean> {
  try {
    const linkStat = await fsp.lstat(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return false;
    }
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.dev === linkStat.dev && stat.ino === linkStat.ino;
  } catch {
    return false;
  }
}

/** Reads a session pointer only when its runtime target still looks session-owned. */
async function readRuntimePointerFile(
  sessionFile: string,
  sessionId: string,
): Promise<string | undefined> {
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  if (!(await isRegularNonSymlinkFile(pointerPath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(pointerPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (parsed.sessionId !== sessionId || typeof parsed.runtimeFile !== "string") {
      return undefined;
    }
    const runtimeFile = path.resolve(parsed.runtimeFile);
    const safeRuntimeFileName = `${safeTrajectorySessionFileName(sessionId)}.jsonl`;
    const defaultRuntimeFile = path.resolve(
      resolveTrajectoryFilePath({
        env: {},
        sessionFile,
        sessionId,
      }),
    );
    if (runtimeFile !== defaultRuntimeFile && path.basename(runtimeFile) !== safeRuntimeFileName) {
      return undefined;
    }
    return runtimeFile;
  } catch {
    return undefined;
  }
}

/** Resolves the best existing runtime sidecar for export, preferring explicit input. */
export async function resolveTrajectoryRuntimeFile(params: {
  runtimeFile?: string;
  sessionFile: string;
  sessionId: string;
}): Promise<string | undefined> {
  if (params.runtimeFile) {
    return params.runtimeFile;
  }
  const candidates = [
    await readRuntimePointerFile(params.sessionFile, params.sessionId),
    resolveTrajectoryFilePath({
      env: {},
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
    resolveTrajectoryFilePath({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
    }),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await isRegularNonSymlinkFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
