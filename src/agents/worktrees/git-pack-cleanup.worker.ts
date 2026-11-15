import fs from "node:fs";
import { tryAcquireWriteLease } from "@openclaw/fs-safe/file-lock";

// Linux leases check open descriptors across UIDs, unlike an unprivileged fuser census.
// Keep SIGIO and the leased descriptor in this disposable process, never the Gateway.
process.on("SIGIO", () => {});
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
    const lease = tryAcquireWriteLease(fd);
    if (!lease) {
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
        !lease.isHeld()
      ) {
        retained++;
        continue;
      }
      fs.unlinkSync(file);
      removed++;
    } finally {
      lease.release();
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
