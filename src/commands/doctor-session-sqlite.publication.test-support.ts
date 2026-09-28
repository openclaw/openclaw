import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function createCompetingRestoreTarget(
  kind: "file" | "dangling-symlink",
  candidatePath: string,
  targetPath: string,
): fs.BigIntStats {
  execFileSync(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const [kind, candidate, target] = process.argv.slice(1);
       if (kind === "file") fs.copyFileSync(candidate, target, fs.constants.COPYFILE_EXCL);
       else fs.symlinkSync(candidate, target);`,
      kind,
      candidatePath,
      targetPath,
    ],
    { timeout: 10_000 },
  );
  return fs.lstatSync(targetPath, { bigint: true });
}
