import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";

export function findOpenFixtureFiles(directories: ReadonlySet<string>): string[] {
  const openFiles: Array<{ descriptor: string; filename: string }> = [];
  if (process.platform === "linux") {
    for (const descriptor of fs.readdirSync("/proc/self/fd")) {
      try {
        openFiles.push({ descriptor, filename: fs.readlinkSync(`/proc/self/fd/${descriptor}`) });
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  } else if (process.platform === "darwin") {
    let descriptor = "";
    for (const field of execFileSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Ffn"], {
      encoding: "utf8",
    }).split("\n")) {
      if (field.startsWith("f")) {
        descriptor = field.slice(1);
      } else if (field.startsWith("n")) {
        openFiles.push({ descriptor, filename: field.slice(1) });
      }
    }
  }
  return openFiles
    .filter(({ filename }) => [...directories].some((root) => isPathInside(root, filename)))
    .map(({ descriptor, filename }) => `${descriptor}: ${filename}`);
}
