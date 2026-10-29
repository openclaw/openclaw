import fs from "node:fs";

const magic = Buffer.from("SQLite format 3\0");
const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(input) || !input.every((pathname) => typeof pathname === "string")) {
  throw new Error("SQLite header probe expects a JSON array of paths");
}
const paths: string[] = input;
let unreadable: { code: unknown; path: string } | undefined;
const results = paths.map((pathname) => {
  if (unreadable) {
    return false;
  }
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
      return fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(magic);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ELOOP") {
      return false;
    }
    unreadable = { code, path: pathname };
    return false;
  }
});
if (unreadable) {
  // The parent names the unreadable source; a stack trace would not.
  process.stderr.write(JSON.stringify(unreadable));
  process.exitCode = 3;
} else {
  process.stdout.write(JSON.stringify(results));
}
