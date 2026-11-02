import fs from "node:fs";

const magic = Buffer.from("SQLite format 3\0");
const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(input) || !input.every((pathname) => typeof pathname === "string")) {
  throw new Error("SQLite header probe expects a JSON array of paths");
}
const paths: string[] = input;
const results = paths.map((pathname) => {
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
    throw error;
  }
});
process.stdout.write(JSON.stringify(results));
