import fs from "node:fs";
import { matchRootFileOpenFailure, openRootFileSync } from "@openclaw/fs-safe/advanced";

export type ControlUiFileRead = {
  rootPath: string;
  rootRealPath?: string;
  filePath: string;
  rejectHardlinks: boolean;
  readBody: boolean;
};

export type ControlUiFileSnapshot = {
  path: string;
  size: number;
  mtimeMs: number;
  body?: Uint8Array;
};

export type ControlUiPreparedFile = Omit<ControlUiFileSnapshot, "body"> & { body?: Buffer };
export type ControlUiRootAsset = {
  file: ControlUiPreparedFile;
  br?: ControlUiPreparedFile | Error | null;
  gzip?: ControlUiPreparedFile | Error | null;
};

export function readControlUiFile(input: ControlUiFileRead): ControlUiFileSnapshot | null {
  const opened = openRootFileSync({
    absolutePath: input.filePath,
    rootPath: input.rootPath,
    rootRealPath: input.rootRealPath,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    // Preserve in-root aliases while fs-safe rejects canonical targets outside the root.
    rejectSymlinks: false,
    rejectHardlinks: input.rejectHardlinks,
  });
  if (!opened.ok) {
    return matchRootFileOpenFailure(opened, {
      io: (failure) => {
        throw failure.error;
      },
      fallback: () => null,
    });
  }
  try {
    const snapshot: ControlUiFileSnapshot = {
      path: opened.path,
      size: opened.stat.size,
      mtimeMs: opened.stat.mtimeMs,
    };
    if (!input.readBody) {
      return snapshot;
    }
    if (opened.stat.size > 2 ** 31 - 1) {
      throw Object.assign(new RangeError("Control UI file exceeds the 2 GiB read limit"), {
        code: "ERR_FS_FILE_TOO_LARGE",
      });
    }
    // An independent backing buffer transfers without copying pooled Buffer memory.
    const body = new Uint8Array(opened.stat.size);
    let offset = 0;
    while (offset < body.length) {
      const count = fs.readSync(opened.fd, body, {
        offset,
        length: Math.min(512 * 1024, body.length - offset),
        position: offset,
      });
      if (count === 0) {
        break;
      }
      offset += count;
    }
    snapshot.body = offset === body.length ? body : body.slice(0, offset);
    return snapshot;
  } finally {
    fs.closeSync(opened.fd);
  }
}
