import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { root as openFsRoot } from "@openclaw/fs-safe/root";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  assertDiagnosticPathAllowed,
  DIAGNOSTIC_FILE_SCOPE_ERROR,
  matchesDiagnosticLogName,
  resolveProtectedDiagnosticPaths,
  type ProtectedDiagnosticPaths,
} from "../logging/diagnostic-file-scope.js";
import { getResolvedLoggerFileTarget } from "../logging/logger.js";
import { redactToolPayloadText } from "../logging/redact.js";

const INSTALL_FILE_MAX_BYTES = 64 * 1024;
type SystemAgentInstallFileRoots = ProtectedDiagnosticPaths & {
  installRoot: string | null;
  logFile: string;
  logRolling: boolean;
};

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
    matchesDiagnosticLogName(name, { file: logFile, rolling: logRolling });
  const scope = installRelative ? installScope : inLogs ? logScope : null;
  const relative = installRelative ?? name;
  if (!scope || relative.split(path.sep).some((part) => part.startsWith("."))) {
    throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
  }
  const opened = await scope
    .open(relative, { hardlinks: "reject", symlinks: "reject" })
    .catch(() => null);
  if (!opened) {
    throw new Error(DIAGNOSTIC_FILE_SCOPE_ERROR);
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
  // Redaction needs complete values, including multiline secrets. Never emit a partial file.
  if (bytes.length > INSTALL_FILE_MAX_BYTES) {
    throw new Error("Diagnostic file exceeds 64 KiB. For large Gateway logs, use the logs action.");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Binary file refused: ${requested}`);
  }
  const text = redactToolPayloadText(decoded);
  return `${real}\n${text}`;
}
