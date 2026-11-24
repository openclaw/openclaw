import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";

type FileIdentity = { dev: bigint; ino: bigint };
export type CommandStdinFileSource = FileIdentity & { path: string };
export type CommandStdinFile = { fd: number; source: CommandStdinFileSource };
export type CommandInputOptions = {
  input?: string | Uint8Array;
  /** Borrow an arbitrary descriptor, including non-reopenable pipes and shared offsets. */
  stdinFileDescriptor?: number;
  stdinFile?: CommandStdinFile;
};

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK;

function stdinFileError(reason: string) {
  return Object.assign(new Error(`Cannot use command stdin file: ${reason}`), {
    code: "ERR_COMMAND_STDIN_FILE",
  });
}

/** Borrow a validated regular file at offset zero. Keep its handle open until the command settles. */
export function bindCommandStdinFile({
  realPath,
  handle,
  exactIdentity: { dev, ino },
}: {
  realPath: string;
  handle: { fd: number };
  exactIdentity: FileIdentity;
}): CommandStdinFile {
  return { fd: handle.fd, source: { path: realPath, dev, ino } };
}

/** Pin a regular file and capture its exact identity for an off-process spawn. */
export async function openCommandStdinFile(filePath: string) {
  const absolutePath = path.resolve(filePath);
  const handle = await open(absolutePath, readFlags);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw stdinFileError("expected a regular file");
    }
    return {
      stdinFile: bindCommandStdinFile({ realPath: absolutePath, handle, exactIdentity: stat }),
      size: stat.size,
      [Symbol.asyncDispose]: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function reopenCommandStdinFile(source: CommandStdinFileSource) {
  const handle = await open(source.path, readFlags).catch((error: unknown) => {
    throw stdinFileError(`open failed (${extractErrorCode(error) ?? "unknown error"})`);
  });
  try {
    const stat = await handle.stat({ bigint: true }).catch((error: unknown) => {
      throw stdinFileError(`stat failed (${extractErrorCode(error) ?? "unknown error"})`);
    });
    if (!stat.isFile() || stat.dev !== source.dev || stat.ino !== source.ino) {
      throw stdinFileError("file identity changed");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
