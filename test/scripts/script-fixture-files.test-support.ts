import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Real files shared by the compiler and updater boundary fixtures. */
export function fixtureFiles(root: string) {
  const file = (name: string) => path.join(root, name);
  const write = (name: string, source: string) => {
    const target = file(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    return target;
  };
  return {
    root,
    file,
    write,
    json: (name: string, value: unknown) => write(name, JSON.stringify(value)),
    read: (name: string) => fs.readFileSync(file(name), "utf8"),
    load: (name: string) => import(pathToFileURL(file(name)).href),
  };
}
