import { createRequire as makeRequire } from "node:module";
import * as moduleApi from "node:module";
const required = makeRequire(import.meta.url);
required("node:fs").readdirSync("root", { recursive: true });
const { readdir: read } = required("node:fs/promises");
read("root", { recursive: true });
moduleApi
  .createRequire(import.meta.url)("fs")
  .readdirSync("root", { recursive: true });
process.getBuiltinModule("node:fs").readdirSync("root", { recursive: true });
const builtin = process.getBuiltinModule("node:fs");
builtin.promises.readdir("root", { recursive: true });
required("node:fs").readdirSync("root", { recursive: false });
builtin.readdirSync("root", { withFileTypes: true });
function unrelated(process: {
  getBuiltinModule: (name: string) => { readdirSync(root: string, options: unknown): void };
}) {
  process.getBuiltinModule("node:fs").readdirSync("root", { recursive: true });
}
void unrelated;
const imported = (await import("node:fs")).default;
imported.readdirSync("root", { recursive: true });
imported.readdirSync("root", { recursive: false });
