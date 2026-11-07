import fs from "node:fs";
import path from "node:path";
import { isNodeError } from "@openclaw/fs-safe/path";

let warned = false;

/** Select the opt-in only for the descriptor-bound mount that fs-safe admits. */
export function allowDrvfsRenameRecovery(directory: string): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  let fd: number | undefined;
  try {
    if (fs.statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) {
      return false;
    }
    let parent = directory;
    for (;;) {
      try {
        // Preserve filesystem traversal of symlink/.. rather than normalizing it.
        fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          return false;
        }
        const ancestor = path.dirname(parent);
        if (ancestor === parent) {
          return false;
        }
        parent = ancestor;
      }
    }
    if (fs.statfsSync(`/proc/self/fd/${fd}`, { bigint: true }).type !== 0x01021997n) {
      return false;
    }
    const ids = [
      ...fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").matchAll(/^mnt_id:\s*(\d+)\s*$/gm),
    ];
    if (ids.length !== 1) {
      return false;
    }
    const entries = fs
      .readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter((line) => line.split(" ")[0] === ids[0]![1]);
    if (entries.length !== 1) {
      return false;
    }
    const [before, after, extra] = entries[0]!.split(" - ");
    if (!before || !after || extra !== undefined || before.split(" ").length < 6) {
      return false;
    }
    const fields = after.split(" ");
    if (
      fields.length !== 3 ||
      fields[0] !== "9p" ||
      !fields[2]!
        .split(",")
        .some((option) => option === "aname=drvfs" || option.startsWith("aname=drvfs;"))
    ) {
      return false;
    }
    // This selects policy, never write authority; fs-safe rechecks its retained parent.
    if (!warned) {
      warned = true;
      process.emitWarning(
        "Verified DrvFS mount: atomic-write rename recovery is enabled. Closing the final file descriptor leaves residual inode-reuse risk; prefer a Docker volume or a WSL ext4 path.",
        { code: "DRVFS_RENAME_RECOVERY" },
      );
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
