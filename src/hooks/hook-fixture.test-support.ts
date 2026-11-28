import fs from "node:fs";
import path from "node:path";

export function writeHookFixture(
  dir: string,
  descriptor: string,
  handler = "export default async () => {};\n",
  handlerFile = "handler.ts",
) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "HOOK.md"), descriptor, "utf8");
  fs.writeFileSync(path.join(dir, handlerFile), handler, "utf8");
}
