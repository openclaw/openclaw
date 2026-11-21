import fs from "node:fs";
import path from "node:path";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { isCurrentRuntimeSupported, isSupportedNodeVersion } from "./runtime-guard.js";

const SQLITE_LIBRARY_HEADER = "// openclaw-package-recovery-sqlite: ";

/** The existing helper digest binds this recovery hint without changing the v1 journal. */
export function sealPackageActivationSqliteLibrary(helper: Buffer, library?: string): Buffer {
  return library
    ? Buffer.concat([Buffer.from(`${SQLITE_LIBRARY_HEADER}${JSON.stringify(library)}\n`), helper])
    : helper;
}

export function readPackageActivationSqliteLibrary(helper: Buffer): string | undefined {
  const end = helper.indexOf(10);
  const firstLine = helper.subarray(0, end < 0 ? helper.length : end).toString("utf8");
  if (!firstLine.startsWith(SQLITE_LIBRARY_HEADER)) {
    return undefined;
  }
  const library: unknown = JSON.parse(firstLine.slice(SQLITE_LIBRARY_HEADER.length));
  if (typeof library !== "string" || !path.isAbsolute(library)) {
    throw new Error("Package recovery SQLite library must be an absolute path.");
  }
  return library;
}

export function packageActivationSqliteEnvironment(library: string): string {
  return `OPENCLAW_SQLITE_LIBRARY=${quoteCliArg(library)}`;
}

export async function assertPackageActivationRecoveryRuntime(helper: string): Promise<void> {
  if (
    process.platform !== "win32" &&
    (process.versions.bun
      ? await isCurrentRuntimeSupported()
      : isSupportedNodeVersion(process.versions.node))
  ) {
    return;
  }
  const library = readPackageActivationSqliteLibrary(fs.readFileSync(helper));
  throw new Error(
    "Package publication recovery requires supported external Node or Bun on POSIX." +
      (library ? ` Retry with ${packageActivationSqliteEnvironment(library)}.` : ""),
  );
}
