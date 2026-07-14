// Fallback copy-based write strategy for exec approvals persistence.
// Used when atomic rename fails (e.g. cross-device or Windows locking).
import fs from "node:fs";

export type ExecApprovalsFallbackDestination = {
  existed: boolean;
  fd: number;
  snapshot: Buffer | null;
};

export function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readExecApprovalsFallbackSnapshotFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

function validateExecApprovalsFallbackFd(filePath: string, fd: number): fs.Stats {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to write exec approvals via symlink: ${filePath}`);
  }
  const pathStat = fs.statSync(filePath);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isFile()) {
    throw new Error(`Refusing copy fallback for non-file exec approvals path: ${filePath}`);
  }
  if (fdStat.nlink > 1) {
    throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
  }
  if (!sameFilesystemEntry(pathStat, fdStat)) {
    throw new Error(`Refusing copy fallback after exec approvals path changed: ${filePath}`);
  }
  return fdStat;
}

function openExistingExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag, 0o600);
  try {
    validateExecApprovalsFallbackFd(filePath, fd);
    return {
      existed: true,
      fd,
      snapshot: readExecApprovalsFallbackSnapshotFromFd(fd),
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort after validation failure
    }
    throw err;
  }
}

function createExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      0o600,
    );
    try {
      validateExecApprovalsFallbackFd(filePath, fd);
      return { existed: false, fd, snapshot: null };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort after validation failure
      }
      throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return openExistingExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function openExecApprovalsFallbackDestination(filePath: string): ExecApprovalsFallbackDestination {
  try {
    return openExistingExecApprovalsFallbackDestination(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return createExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function writeExecApprovalsFallbackBuffer(fd: number, contents: Buffer): void {
  fs.ftruncateSync(fd, 0);
  let written = 0;
  while (written < contents.length) {
    written += fs.writeSync(fd, contents, written, contents.length - written, written);
  }
  fs.ftruncateSync(fd, contents.length);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsFallbackDestination(
  filePath: string,
  destination: ExecApprovalsFallbackDestination,
): void {
  if (!destination.existed) {
    try {
      const pathStat = fs.statSync(filePath);
      const fdStat = fs.fstatSync(destination.fd);
      if (sameFilesystemEntry(pathStat, fdStat)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  writeExecApprovalsFallbackBuffer(destination.fd, destination.snapshot ?? Buffer.alloc(0));
}

export function copyExecApprovalsFallback(tempPath: string, filePath: string): void {
  const contents = fs.readFileSync(tempPath);
  const destination = openExecApprovalsFallbackDestination(filePath);
  try {
    writeExecApprovalsFallbackBuffer(destination.fd, contents);
    validateExecApprovalsFallbackFd(filePath, destination.fd);
  } catch (copyErr) {
    try {
      restoreExecApprovalsFallbackDestination(filePath, destination);
    } catch (restoreErr) {
      throw new Error(
        `Failed to restore exec approvals after copy fallback failure for ${filePath}: ${String(
          copyErr,
        )}`,
        { cause: restoreErr },
      );
    }
    throw copyErr;
  } finally {
    fs.closeSync(destination.fd);
  }
}
