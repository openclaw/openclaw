import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";

type TrashCommand = { cmd: string; args: (targetPath: string) => string[] };

/**
 * Ordered list of trash CLI commands to attempt.
 * On macOS, `trash` is typically the only option (via Homebrew trash-cli or
 * the built-in `trash` wrapper). On Linux, `gio trash` is the most
 * universally available (ships with GLib/GNOME), followed by `trash-put`
 * and `trash` from trash-cli.
 */
function resolveTrashCommands(): TrashCommand[] {
  if (process.platform === "darwin") {
    return [{ cmd: "trash", args: (p) => [p] }];
  }
  // Linux (and other Unix-like)
  return [
    { cmd: "trash", args: (p) => [p] },
    { cmd: "gio", args: (p) => ["trash", p] },
    { cmd: "trash-put", args: (p) => [p] },
  ];
}

/**
 * Resolve the platform-appropriate fallback trash directory.
 *
 * - macOS: `~/.Trash`
 * - Linux: `$XDG_DATA_HOME/Trash/files` (defaults to `~/.local/share/Trash/files`)
 *
 * On Linux the XDG Trash specification requires an `info/` sibling directory
 * with `.trashinfo` metadata files. We create both directories but only write
 * the mandatory info entry so that file managers can display the trashed item.
 */
function resolveTrashDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".Trash");
  }
  const xdgDataHome = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share");
  return path.join(xdgDataHome, "Trash", "files");
}

/**
 * Write a minimal `.trashinfo` file so that XDG-compliant file managers
 * (Nautilus, Dolphin, Thunar, etc.) can show and restore the trashed item.
 */
function writeTrashInfo(trashDir: string, destName: string, originalPath: string): void {
  try {
    const infoDir = path.join(path.dirname(trashDir), "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    const content = `[Trash Info]\nPath=${originalPath}\nDeletionDate=${now}\n`;
    fs.writeFileSync(path.join(infoDir, `${destName}.trashinfo`), content, "utf8");
  } catch {
    // Best-effort: the file itself is already in Trash/files.
  }
}

/**
 * Move a file or directory to the system Trash.
 *
 * Returns the original `targetPath` on success — CLI trash commands do not
 * expose the destination path, so the return value is consistently the path
 * that was trashed rather than where it ended up.
 */
export async function movePathToTrash(targetPath: string): Promise<string> {
  const commands = resolveTrashCommands();

  for (const { cmd, args } of commands) {
    try {
      await runExec(cmd, args(targetPath), { timeoutMs: 10_000 });
      return targetPath;
    } catch {
      // Try the next command.
    }
  }

  // Manual fallback: move the file/directory into the trash directory.
  const trashDir = resolveTrashDir();
  fs.mkdirSync(trashDir, { recursive: true });

  const base = path.basename(targetPath);
  let destName = `${base}-${Date.now()}`;
  let dest = path.join(trashDir, destName);
  if (fs.existsSync(dest)) {
    destName = `${base}-${Date.now()}-${Math.random()}`;
    dest = path.join(trashDir, destName);
  }

  fs.renameSync(targetPath, dest);

  // On Linux, write a .trashinfo entry for XDG compliance.
  if (process.platform !== "darwin") {
    writeTrashInfo(trashDir, destName, path.resolve(targetPath));
  }

  return targetPath;
}
