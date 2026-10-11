import fs from "node:fs";
import koffi from "koffi";

// Linux leases check open descriptors across UIDs, unlike an unprivileged fuser census.
// Keep SIGIO and the leased descriptor in this disposable process, never the Gateway.
process.on("SIGIO", () => {});
const fcntl = koffi.load(null).func("int fcntl(int fd, int command, ...)");
const F_SETLEASE = 1024;
const F_GETLEASE = 1025;
const F_WRLCK = 1;
const F_UNLCK = 2;
// SAFETY: The maintenance owner sends this private packet after its live input guard.
const { files, olderThan } = JSON.parse(fs.readFileSync(0, "utf8")) as {
  files: string[];
  olderThan: number;
};
let removed = 0;
let retained = 0;
for (const file of files) {
  if (removed >= 256) {
    break;
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const original = fs.fstatSync(fd);
    if (!original.isFile() || original.mtimeMs >= olderThan) {
      continue;
    }
    if (fcntl(fd, F_SETLEASE, "int", F_WRLCK) !== 0) {
      retained++;
      continue;
    }
    try {
      const current = fs.lstatSync(file);
      if (
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.size !== original.size ||
        current.mtimeMs !== original.mtimeMs ||
        current.ctimeMs !== original.ctimeMs ||
        fcntl(fd, F_GETLEASE) !== F_WRLCK
      ) {
        retained++;
        continue;
      }
      fs.unlinkSync(file);
      removed++;
    } finally {
      fcntl(fd, F_SETLEASE, "int", F_UNLCK);
    }
  } catch {
    retained++;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
process.stdout.write(JSON.stringify({ removed, retained }));
