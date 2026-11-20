import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import { openRootFileSync } from "../../infra/boundary-file-read.js";

export async function ensureWritableSkillDirectories(
  boundary: Root,
  relativePath: string,
  assertCurrent?: () => void,
  sourceMode?: number,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const fixedRoot = boundary.rootReal;
  const visit = async (
    relativeDir: string,
    observed?: Awaited<ReturnType<Root["stat"]>>,
  ): Promise<void> => {
    const scopedPath = `.${path.sep}${relativeDir}`;
    // Listing already admits child metadata; only a mode change needs a mutation descriptor.
    const current = observed ?? (await boundary.stat(scopedPath));
    if (
      !current.isDirectory ||
      current.isSymbolicLink ||
      current.mode !== ((sourceMode ?? current.mode) | 0o700)
    ) {
      const opened = openRootFileSync({
        absolutePath: path.join(fixedRoot, relativeDir),
        rootPath: fixedRoot,
        rootRealPath: fixedRoot,
        boundaryLabel: "skills directory",
        allowedType: "directory",
        symlinks: "reject",
      });
      if (!opened.ok) {
        throw new Error("Could not open skill directory safely", { cause: opened.error });
      }
      try {
        // Sealed release copies (including legacy sandboxes) need writable directories, not files.
        const writableMode = (sourceMode ?? opened.stat.mode) | 0o700;
        if (opened.stat.mode !== writableMode) {
          assertCurrent?.();
          fs.fchmodSync(opened.fd, writableMode);
        }
      } finally {
        fs.closeSync(opened.fd);
      }
    }
    // Copying owns this directory's children; only legacy cleanup walks the tree.
    if (sourceMode !== undefined) {
      return;
    }
    const children = await boundary.list(scopedPath, { withFileTypes: true });
    assertCurrent?.();
    for (const child of children) {
      if (child.isDirectory && !child.isSymbolicLink) {
        await visit(path.join(relativeDir, child.name), child);
      }
    }
  };
  await visit(relativePath);
}
