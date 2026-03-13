import fs from "node:fs/promises";

export async function tryCreateSymlink(
  target: string,
  linkPath: string,
  type?: Parameters<typeof fs.symlink>[2],
): Promise<boolean> {
  try {
    if (type === undefined) {
      await fs.symlink(target, linkPath);
    } else {
      await fs.symlink(target, linkPath, type);
    }
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (process.platform === "win32" && (err.code === "EPERM" || err.code === "EACCES")) {
      return false;
    }
    throw error;
  }
}
