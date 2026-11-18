import fs from "node:fs";
import path from "node:path";

/**
 * `fs.cp` filter that keeps a Windows junction a junction. Node recreates a
 * copied junction as a directory symlink, which needs a privilege that junctions
 * do not. Relative links stay with Node's verbatim copy.
 */
export function copyWindowsJunction(source: string, destination: string): boolean {
  if (process.platform !== "win32" || !fs.lstatSync(source).isSymbolicLink()) {
    return true;
  }
  const target = fs.readlinkSync(source);
  if (!path.isAbsolute(target) || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    return true;
  }
  fs.symlinkSync(target, destination, "junction");
  return false;
}
