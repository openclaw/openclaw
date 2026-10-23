import fs from "node:fs";
import path from "node:path";

export function files(root: string) {
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => fs.readFileSync(file(name), "utf8");
  return {
    read,
    json: (name: string) => JSON.parse(read(name)),
    append: (name: string, text: string) => fs.appendFileSync(file(name), text),
    write: (name: string, content: string, options: { mode?: number } = {}) => {
      fs.mkdirSync(path.dirname(file(name)), { recursive: true });
      fs.writeFileSync(file(name), content, options);
    },
    exists: (name: string) => fs.existsSync(file(name)),
    linkDependencies: (
      type: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir",
    ) => fs.symlinkSync(path.resolve("node_modules"), file("node_modules"), type),
  };
}
