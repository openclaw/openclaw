import fsp from "node:fs/promises";
import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { realpathForExec } from "./exec-command-resolution.js";

function pathComponentsFromRoot(targetPath: string): string[] {
  const parts: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    parts.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return parts;
    }
    cursor = parent;
  }
}

async function isOwnedByCurrentProcess(candidate: string): Promise<boolean> {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }
  const stat = await fsp.stat(candidate).catch(() => null);
  return stat !== null && stat.uid === process.getuid();
}

async function isMutableByCurrentProcess(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate, fsp.constants.W_OK);
    return true;
  } catch {
    return await isOwnedByCurrentProcess(candidate);
  }
}

export async function hasMutableSymlinkPathComponent(targetPath: string): Promise<boolean> {
  for (const component of pathComponentsFromRoot(targetPath)) {
    try {
      if (!(await fsp.lstat(component)).isSymbolicLink()) {
        continue;
      }
      if (await isMutableByCurrentProcess(path.dirname(component))) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

async function isMutableShellPath(targetPath: string): Promise<boolean> {
  return (
    (await isMutableByCurrentProcess(targetPath)) ||
    (await isMutableByCurrentProcess(path.dirname(targetPath))) ||
    (await hasMutableSymlinkPathComponent(targetPath))
  );
}

export async function pathLooksMutableForShellPayload(targetPath: string): Promise<boolean> {
  if (await isMutableShellPath(targetPath)) {
    return true;
  }
  const realPath = await realpathForExec(targetPath).catch(() => null);
  return !realPath || (await isMutableShellPath(realPath));
}

export function looksLikePathToken(token: string): boolean {
  return looksLikeExplicitPathToken(token) || path.extname(token).length > 0;
}

export function looksLikeExplicitPathToken(token: string): boolean {
  return (
    token.startsWith(".") ||
    token.startsWith("/") ||
    token.startsWith("\\") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

export async function resolvesToExistingFile(
  rawOperand: string,
  cwd: string | undefined,
): Promise<boolean> {
  if (!rawOperand) {
    return false;
  }
  try {
    return (await fsp.stat(path.resolve(cwd ?? process.cwd(), rawOperand))).isFile();
  } catch {
    return false;
  }
}

// ELF, Mach-O, and fat executable headers, including both Mach-O byte orders.
const BINARY_EXECUTABLE_MAGICS = new Set([
  0x7f454c46, 0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
  0xbfbafeca,
]);

function isKnownBinaryExecutableHeader(buffer: Buffer): boolean {
  if (buffer.length >= 4 && BINARY_EXECUTABLE_MAGICS.has(buffer.readUInt32BE(0))) {
    return true;
  }
  if (buffer.length < 0x40 || buffer.readUInt16BE(0) !== 0x4d5a) {
    return false;
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  return peOffset <= buffer.length - 4 && buffer.readUInt32BE(peOffset) === 0x50450000;
}

export async function isLikelyScriptLikePath(targetPath: string): Promise<boolean> {
  if (!(await fsp.stat(targetPath).catch(() => null))?.isFile()) {
    return true;
  }
  let header: Buffer;
  try {
    const fd = await fsp.open(targetPath, "r");
    try {
      header = Buffer.alloc(1024);
      const bytesRead = await readFileWindowFully(fd, header, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    return true;
  }
  if (header.length === 0 || (header[0] === 0x23 && header[1] === 0x21)) {
    return true;
  }
  return !isKnownBinaryExecutableHeader(header);
}
