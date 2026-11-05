import fs from "node:fs";
import path from "node:path";

const magic = Buffer.from("SQLite format 3\0");
const retryDelaysMs = [50, 100];
const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(input) || !input.every((pathname) => typeof pathname === "string")) {
  throw new Error("SQLite header probe expects a JSON array of paths");
}
const paths: string[] = input;
let unreadable: { code: unknown; errno: unknown; path: string } | undefined;
const retriedSources: string[] = [];
const results = paths.map((candidate) => {
  if (unreadable) {
    return false;
  }
  const pathname = path.resolve(candidate);
  for (let attempt = 0; ; attempt++) {
    try {
      if (!fs.lstatSync(pathname).isFile()) {
        return false;
      }
      const fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        if (!fs.fstatSync(fd).isFile()) {
          return false;
        }
        const header = Buffer.alloc(magic.length);
        return (
          fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(magic)
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ELOOP") {
        return false;
      }
      const delay = retryDelaysMs[attempt];
      if (
        process.platform === "win32" &&
        (code === "EBUSY" || code === "EPERM") &&
        delay !== undefined
      ) {
        if (attempt === 0) {
          retriedSources.push(`${pathname} (${code})`);
        }
        // Windows scanners can briefly deny reads. Close the descriptor before
        // backing off in this isolated child, then reopen and classify normally.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        continue;
      }
      unreadable = {
        code,
        errno: error instanceof Error && "errno" in error ? error.errno : undefined,
        path: pathname,
      };
      return false;
    }
  }
});
if (unreadable) {
  // Descriptor read errors omit their path. Never publish partial classifications.
  process.stderr.write(JSON.stringify(unreadable));
  process.exitCode = 3;
} else {
  process.stdout.write(JSON.stringify(results));
  if (retriedSources.length > 0) {
    process.stderr.write(retriedSources.join("\n"));
  }
}
