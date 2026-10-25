import fs from "node:fs";

const magic = Buffer.from("SQLite format 3\0");
// Only the typed header-probe launcher supplies this private process's input.
const paths = JSON.parse(fs.readFileSync(0, "utf8")) as string[];
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") {
      return false;
    }
    throw error;
  }
});
process.stdout.write(JSON.stringify(results));
