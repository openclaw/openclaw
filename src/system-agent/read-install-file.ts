import fs from "node:fs/promises";
import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSameRollingLogFileFamily } from "../logging/log-file-path.js";
import { getResolvedLoggerFileTarget } from "../logging/logger.js";
import { redactToolPayloadText } from "../logging/redact.js";

export const INSTALL_FILE_MAX_BYTES = 64 * 1024;

export type SystemAgentInstallFileRoots = {
  installRoot: string | null;
  logFile: string;
  stateDir: string;
};

async function resolveDefaultRoots(): Promise<SystemAgentInstallFileRoots> {
  return {
    installRoot: await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
    }),
    logFile: (await getResolvedLoggerFileTarget()).file,
    stateDir: resolveStateDir(),
  };
}

const realpathOrNull = (target: string) => fs.realpath(target).catch(() => null);

export async function readSystemAgentInstallFile(
  requested: string,
  roots?: SystemAgentInstallFileRoots,
): Promise<string> {
  const { installRoot, logFile, stateDir } = roots ?? (await resolveDefaultRoots());
  const realInstallRoot = installRoot ? await realpathOrNull(installRoot) : null;
  if (!path.isAbsolute(requested) && !realInstallRoot) {
    throw new Error("The OpenClaw install root was not found; pass an absolute log file path.");
  }
  const real = await realpathOrNull(path.resolve(realInstallRoot ?? "", requested));
  if (!real) {
    throw new Error(`File not found: ${requested}`);
  }
  const realLogDir = await realpathOrNull(path.dirname(logFile));
  const inLogs =
    realLogDir !== null &&
    path.dirname(real) === realLogDir &&
    (path.basename(real) === path.basename(logFile) || isSameRollingLogFileFamily(logFile, real));
  const root =
    realInstallRoot && isPathInside(realInstallRoot, real)
      ? realInstallRoot
      : inLogs
        ? realLogDir
        : null;
  if (!root) {
    throw new Error(
      "Only files under the OpenClaw install root or the Gateway log file can be read.",
    );
  }
  const realStateDir = (await realpathOrNull(stateDir)) ?? path.resolve(stateDir);
  if (
    (isPathInside(realStateDir, real) && !isPathInside(realStateDir, root)) ||
    path
      .relative(root, real)
      .split(path.sep)
      .some((part) => part.startsWith("."))
  ) {
    throw new Error("State directory files and hidden files are not readable.");
  }
  if (!(await fs.stat(real)).isFile()) {
    throw new Error(`Not a regular file: ${requested}`);
  }
  const handle = await fs.open(real, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(INSTALL_FILE_MAX_BYTES + 1);
    bytes = buffer.subarray(0, await readFileWindowFully(handle, buffer, 0));
  } finally {
    await handle.close();
  }
  if (bytes.includes(0)) {
    throw new Error(`Binary file refused: ${requested}`);
  }
  const truncated = bytes.length > INSTALL_FILE_MAX_BYTES;
  const text = redactToolPayloadText(bytes.subarray(0, INSTALL_FILE_MAX_BYTES).toString("utf8"));
  return `${real}${truncated ? " (truncated at 64 KiB)" : ""}\n${text}`;
}
