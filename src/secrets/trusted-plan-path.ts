import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readOwnerAndDaclBatch, type OwnerAndDaclResult } from "@openclaw/fs-safe/permissions";
import { trustedWindowsPlanPathFailure } from "./trusted-plan-path-policy.js";

async function readShebangInterpreter(targetPath: string): Promise<string | undefined> {
  const handle = await fs.open(targetPath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) {
      return undefined;
    }
    const newline = buffer.indexOf(0x0a, 2);
    if (newline < 0) {
      throw new Error(`script interpreter line is too long: ${targetPath}`);
    }
    const line = buffer.subarray(2, newline).toString("utf8").trim();
    const interpreter = line.split(/\s+/u, 1)[0];
    if (!interpreter || !path.isAbsolute(interpreter)) {
      throw new Error(`script interpreter must be an absolute path: ${targetPath}`);
    }
    return interpreter;
  } finally {
    await handle.close();
  }
}

async function assertTrustedPathChain(
  resolvedPath: string,
  targetType: "directory" | "file",
  options: { allowWindowsTargetTrustedInstaller?: boolean } = {},
): Promise<void> {
  const entries: Array<{ path: string; before: Stats }> = [];
  let cursor = resolvedPath;
  for (;;) {
    entries.push({ path: cursor, before: await fs.lstat(cursor) });
    const parentPath = path.dirname(cursor);
    if (parentPath === cursor) {
      break;
    }
    cursor = parentPath;
  }
  let windows: OwnerAndDaclResult[] | undefined;
  if (process.platform === "win32") {
    try {
      windows = await readOwnerAndDaclBatch(entries.map((entry) => entry.path));
    } catch (cause) {
      throw new Error(`permissions could not be verified for path chain: ${resolvedPath}`, {
        cause,
      });
    }
  }
  for (const [index, entry] of entries.entries()) {
    const { before, path: currentPath } = entry;
    const after = await fs.lstat(currentPath);
    if (
      before.isSymbolicLink() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error(`path changed during permission verification: ${currentPath}`);
    }
    const directory = index > 0 || targetType === "directory";
    if (after.isDirectory() !== directory) {
      throw new Error(`unexpected path type: ${currentPath}`);
    }
    let failure: string | undefined;
    if (windows) {
      failure = trustedWindowsPlanPathFailure(windows[index]!, {
        directory,
        allowChildCreation: targetType === "directory" || index !== 1,
        allowTrustedInstaller: index > 0 || options.allowWindowsTargetTrustedInstaller === true,
      });
    } else {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid === undefined || (after.uid !== uid && after.uid !== 0)) {
        failure = "path is not owned by the current user or root";
      } else if ((after.mode & 0o022) !== 0 && !(directory && (after.mode & 0o1000) !== 0)) {
        failure = "path is writable by another user";
      }
    }
    if (failure) {
      throw new Error(`${failure}: ${currentPath}`);
    }
  }
  // Recheck from the trusted root toward the target after the full chain is known.
  for (const entry of entries.toReversed()) {
    const current = await fs.lstat(entry.path);
    if (
      current.isSymbolicLink() ||
      current.dev !== entry.before.dev ||
      current.ino !== entry.before.ino
    ) {
      throw new Error(`path changed after permission verification: ${entry.path}`);
    }
  }
}

async function assertTrustedPath(
  targetPath: string,
  validatedScripts = new Set<string>(),
  options: { allowWindowsTargetTrustedInstaller?: boolean } = {},
): Promise<string> {
  const resolvedPath = await fs.realpath(targetPath);
  const targetStat = await fs.stat(resolvedPath);
  if (!targetStat.isFile()) {
    throw new Error(`path is not a regular file: ${resolvedPath}`);
  }
  await fs.access(resolvedPath, fsSync.constants.X_OK);
  await assertTrustedPathChain(resolvedPath, "file", options);
  if (process.platform === "win32" && path.extname(resolvedPath).toLowerCase() !== ".exe") {
    throw new Error(`Windows executable must be an .exe file: ${resolvedPath}`);
  }
  const interpreter = await readShebangInterpreter(resolvedPath);
  if (interpreter) {
    if (validatedScripts.has(resolvedPath)) {
      throw new Error(`script interpreter cycle detected: ${resolvedPath}`);
    }
    validatedScripts.add(resolvedPath);
    if (path.basename(interpreter).toLowerCase() === "env") {
      throw new Error(`script interpreter may not use env indirection: ${resolvedPath}`);
    }
    const resolvedInterpreter = await assertTrustedPath(interpreter, validatedScripts);
    // The kernel launches the literal shebang path, so aliases cannot use an unverified link.
    if (resolvedInterpreter !== interpreter) {
      throw new Error(`script interpreter path must be canonical: ${interpreter}`);
    }
  }
  return resolvedPath;
}

export async function resolveTrustedExecutablePath(targetPath: string): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Executable path must be absolute: ${targetPath}`);
  }
  return await assertTrustedPath(targetPath);
}

export async function resolveTrustedWindowsSystemExecutablePath(
  targetPath: string,
): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Executable path must be absolute: ${targetPath}`);
  }
  return await assertTrustedPath(targetPath, new Set(), {
    allowWindowsTargetTrustedInstaller: true,
  });
}

export async function resolveTrustedPlanDirectoryPath(targetPath: string): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Directory path must be absolute: ${targetPath}`);
  }
  const resolvedPath = await fs.realpath(targetPath);
  await assertTrustedPathChain(resolvedPath, "directory");
  return resolvedPath;
}
