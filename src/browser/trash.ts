import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";

export async function movePathToTrash(targetPath: string): Promise<string> {
  // Try multiple trash commands — trash-cli may not be installed on minimal Linux.
  const commands: [string, string[]][] = [
    ["trash", [targetPath]],
    ["gio", ["trash", targetPath]],
    ["trash-put", [targetPath]],
  ];
  for (const [cmd, args] of commands) {
    try {
      await runExec(cmd, args, { timeoutMs: 10_000 });
      return targetPath;
    } catch {
      // Try next command.
    }
  }
  // Last resort: move to ~/.Trash manually.
  const trashDir = path.join(os.homedir(), ".Trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const base = path.basename(targetPath);
  let dest = path.join(trashDir, `${base}-${Date.now()}`);
  if (fs.existsSync(dest)) {
    dest = path.join(trashDir, `${base}-${Date.now()}-${Math.random()}`);
  }
  fs.renameSync(targetPath, dest);
  return dest;
}
