import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { openRootFileSync } from "../../infra/boundary-file-read.js";

export async function ensureWritableSkillDirectories(
  skillsDir: string,
  relativePath: string,
  assertCurrent?: () => void,
  sourceMode?: number,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const fixedRoot = path.join(
    await fs.promises.realpath(path.dirname(skillsDir)),
    path.basename(skillsDir),
  );
  assertCurrent?.();
  const boundary = await root(fixedRoot);
  assertCurrent?.();
  if (boundary.rootReal !== fixedRoot) {
    throw new Error("Skill directory root must not be a symbolic link");
  }
  const visit = async (relativeDir: string, initialMode?: number): Promise<void> => {
    const scopedPath = `.${path.sep}${relativeDir}`;
    const stat = await boundary.stat(scopedPath);
    assertCurrent?.();
    if (stat.isSymbolicLink || !stat.isDirectory) {
      return;
    }
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
      const writableMode = (initialMode ?? opened.stat.mode) | 0o700;
      if (opened.stat.mode !== writableMode) {
        assertCurrent?.();
        fs.fchmodSync(opened.fd, writableMode);
      }
    } finally {
      fs.closeSync(opened.fd);
    }
    const children = await boundary.list(scopedPath, { withFileTypes: true });
    assertCurrent?.();
    for (const child of children) {
      if (child.isDirectory && !child.isSymbolicLink) {
        await visit(path.join(relativeDir, child.name));
      }
    }
  };
  await visit(relativePath, sourceMode);
}
