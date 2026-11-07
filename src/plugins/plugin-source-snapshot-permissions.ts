import fs from "node:fs";
import path from "node:path";
import { openRootFileSync } from "../infra/boundary-file-read.js";

type Invalid = (detail: string) => never;

/** Change only the pinned, owned directory; never follow a substituted link. */
function directoryMode(filename: string, mode: number, invalid: Invalid): void {
  const before = fs.lstatSync(filename, { bigint: true });
  if (!before.isDirectory() || (process.getuid && before.uid !== BigInt(process.getuid()))) {
    invalid(`directory is not owned: ${filename}`);
  }
  if (process.platform === "win32") {
    return;
  }
  const opened = openRootFileSync({
    absolutePath: filename,
    rootPath: filename,
    boundaryLabel: "snapshot owned directory mode",
    allowedType: "directory",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    invalid(`directory failed guarded open: ${filename}`);
  }
  const fd = opened.fd;
  try {
    const pinned = fs.fstatSync(fd, { bigint: true });
    if (
      !pinned.isDirectory() ||
      pinned.dev !== before.dev ||
      pinned.ino !== before.ino ||
      pinned.uid !== before.uid ||
      pinned.gid !== before.gid
    ) {
      invalid(`directory changed before mode update: ${filename}`);
    }
    fs.fchmodSync(fd, mode);
    const after = fs.lstatSync(filename, { bigint: true });
    if (!after.isDirectory() || after.dev !== pinned.dev || after.ino !== pinned.ino) {
      invalid(`directory changed during mode update: ${filename}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function freezePluginSnapshotTree(root: string, invalid: Invalid): void {
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename, { bigint: true });
      if (stat.isDirectory()) {
        visit(filename);
      } else if (stat.isFile()) {
        const opened = openRootFileSync({
          absolutePath: filename,
          rootPath: root,
          boundaryLabel: "snapshot read-only publication",
          rejectHardlinks: true,
        });
        if (!opened.ok) {
          invalid(`file failed guarded open: ${filename}`);
        }
        const fd = opened.fd;
        try {
          const pinned = fs.fstatSync(fd, { bigint: true });
          if (pinned.dev !== stat.dev || pinned.ino !== stat.ino || pinned.nlink !== 1n) {
            invalid(`file changed before mode update: ${filename}`);
          }
          fs.fchmodSync(fd, Number(pinned.mode & 0o555n));
        } finally {
          fs.closeSync(fd);
        }
      } else if (!stat.isSymbolicLink()) {
        invalid(`nonregular snapshot member: ${filename}`);
      }
    }
    directoryMode(directory, 0o500, invalid);
  };
  visit(root);
}

/** Retirement never traverses or chmods foreign content. */
export function makePluginSnapshotTreeRemovable(root: string, invalid: Invalid): void {
  const visit = (directory: string) => {
    directoryMode(directory, 0o700, invalid);
    const before = fs.lstatSync(directory, { bigint: true });
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename, { bigint: true });
      if (process.getuid && stat.uid !== BigInt(process.getuid())) {
        invalid(`snapshot cleanup found unowned content: ${filename}`);
      }
      if (stat.isDirectory()) {
        visit(filename);
      }
    }
    const after = fs.lstatSync(directory, { bigint: true });
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      invalid(`directory changed during snapshot cleanup: ${directory}`);
    }
  };
  visit(root);
}
