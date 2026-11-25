import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as openFsRoot } from "@openclaw/fs-safe/root";
import { resolveConfigPath, resolveIncludeRoots, resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { realpathViaExistingPrefix } from "../infra/path-containment.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSameRollingLogFileFamily } from "../logging/log-file-path.js";
import { getResolvedLoggerFileTarget } from "../logging/logger.js";
import { redactToolPayloadText } from "../logging/redact.js";

const INSTALL_FILE_MAX_BYTES = 64 * 1024;
const FILE_SCOPE_ERROR =
  "The file is outside the diagnostics read scope. Only files under the OpenClaw install root or the Gateway log file can be read, excluding private and hidden files.";

type ProtectedDiagnosticPaths = { configPath: string; stateDir: string; includeRoots: string[] };

type SystemAgentInstallFileRoots = ProtectedDiagnosticPaths & {
  installRoot: string | null;
  logFile: string;
  logRolling: boolean;
};

function resolveProtectedDiagnosticPaths(): ProtectedDiagnosticPaths {
  return {
    configPath: resolveConfigPath(),
    stateDir: resolveStateDir(),
    includeRoots: resolveIncludeRoots(),
  };
}

async function resolveDefaultRoots(): Promise<SystemAgentInstallFileRoots> {
  const log = await getResolvedLoggerFileTarget();
  return {
    ...resolveProtectedDiagnosticPaths(),
    installRoot: await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
    }),
    logFile: log.file,
    logRolling: log.rolling,
  };
}

function relativeDiagnosticPath(
  scope: Awaited<ReturnType<typeof openFsRoot>> | null,
  file: string,
): string | null {
  if (!scope) {
    return null;
  }
  // Accept the declared and canonical spellings of the approved root, not links below it.
  const root = [scope.rootDir, scope.rootReal].find((root) => isPathInside(root, file));
  return root ? path.relative(root, file) : null;
}

async function assertDiagnosticPathAllowed(
  declared: string,
  real: string,
  { configPath, stateDir, includeRoots }: ProtectedDiagnosticPaths,
): Promise<void> {
  // Include candidates are confined to these roots. Protect the roots themselves so a
  // valid or invalid disk edit cannot expose sources the Gateway previously loaded.
  const privateRoots = [path.dirname(configPath), stateDir, ...includeRoots];
  const [realConfig, ...realRoots] = await Promise.all(
    [configPath, ...privateRoots].map(realpathViaExistingPrefix),
  );
  if (
    path.relative(configPath, declared) === "" ||
    privateRoots.some((root) => isPathInside(root, declared)) ||
    !realConfig ||
    path.relative(realConfig, real) === "" ||
    realRoots.some((root) => !root || isPathInside(root, real))
  ) {
    throw new Error(FILE_SCOPE_ERROR);
  }
}

function matchesLogName(candidate: string, target: { file: string; rolling: boolean }): boolean {
  return (
    candidate === path.basename(target.file) ||
    (target.rolling && isSameRollingLogFileFamily(target.file, candidate))
  );
}

export async function openSystemAgentDiagnosticLog(
  file: string,
  target: { file: string; rolling: boolean },
) {
  const logDir = path.dirname(target.file);
  const name = path.basename(file);
  if (
    name.startsWith(".") ||
    path.relative(logDir, file) !== name ||
    !matchesLogName(name, target)
  ) {
    throw new Error(FILE_SCOPE_ERROR);
  }
  const scope = await openFsRoot(logDir);
  const { handle, realPath } = await scope
    .open(name, { hardlinks: "reject", symlinks: "reject" })
    .catch((error: unknown) => {
      if (error instanceof FsSafeError && error.category === "policy") {
        throw new Error(FILE_SCOPE_ERROR);
      }
      throw error;
    });
  try {
    if (path.relative(scope.rootReal, realPath) !== name) {
      throw new Error(FILE_SCOPE_ERROR);
    }
    await assertDiagnosticPathAllowed(file, realPath, resolveProtectedDiagnosticPaths());
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readSystemAgentInstallFile(
  requested: string,
  roots?: SystemAgentInstallFileRoots,
): Promise<string> {
  const paths = roots ?? (await resolveDefaultRoots());
  const { installRoot, logFile, logRolling } = paths;
  const [installScope, logScope] = await Promise.all([
    installRoot ? openFsRoot(installRoot).catch(() => null) : null,
    openFsRoot(path.dirname(logFile)).catch(() => null),
  ]);
  if (!path.isAbsolute(requested) && !installScope) {
    throw new Error("The OpenClaw install root was not found; pass an absolute log file path.");
  }
  const file = path.resolve(installScope?.rootDir ?? "", requested);
  const name = path.basename(file);
  const installRelative = relativeDiagnosticPath(installScope, file);
  const inLogs =
    relativeDiagnosticPath(logScope, file) === name &&
    matchesLogName(name, { file: logFile, rolling: logRolling });
  const scope = installRelative ? installScope : inLogs ? logScope : null;
  const relative = installRelative ?? name;
  if (!scope || relative.split(path.sep).some((part) => part.startsWith("."))) {
    throw new Error(FILE_SCOPE_ERROR);
  }
  const opened = await scope
    .open(relative, { hardlinks: "reject", symlinks: "reject" })
    .catch(() => null);
  if (!opened) {
    throw new Error(FILE_SCOPE_ERROR);
  }
  const { handle, realPath: real } = opened;
  let bytes: Buffer;
  try {
    await assertDiagnosticPathAllowed(path.join(scope.rootDir, relative), real, paths);
    const buffer = Buffer.alloc(INSTALL_FILE_MAX_BYTES + 1);
    bytes = buffer.subarray(0, await readFileWindowFully(handle, buffer, 0));
  } finally {
    await handle.close();
  }
  if (bytes.includes(0)) {
    throw new Error(`Binary file refused: ${requested}`);
  }
  const truncated = bytes.length > INSTALL_FILE_MAX_BYTES;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, INSTALL_FILE_MAX_BYTES),
      { stream: truncated },
    );
  } catch {
    throw new Error(`Binary file refused: ${requested}`);
  }
  const text = redactToolPayloadText(decoded);
  return `${real}${truncated ? " (truncated at 64 KiB)" : ""}\n${text}`;
}
