import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { openRootFileSync } from "../../infra/boundary-file-read.js";

export async function ensureWritableSkillDirectories(
  skillsDir: string,
  relativePath: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const fixedRoot = path.join(
    await fs.promises.realpath(path.dirname(skillsDir)),
    path.basename(skillsDir),
  );
  const boundary = await root(fixedRoot);
  if (boundary.rootReal !== fixedRoot) {
    throw new Error("Skill directory root must not be a symbolic link");
  }
  const visit = async (relativeDir: string): Promise<void> => {
    const scopedPath = `.${path.sep}${relativeDir}`;
    const stat = await boundary.stat(scopedPath);
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
      if ((opened.stat.mode & 0o700) !== 0o700) {
        fs.fchmodSync(opened.fd, opened.stat.mode | 0o700);
      }
    } finally {
      fs.closeSync(opened.fd);
    }
    for (const child of await boundary.list(scopedPath, { withFileTypes: true })) {
      if (child.isDirectory && !child.isSymbolicLink) {
        await visit(path.join(relativeDir, child.name));
      }
    }
  };
  await visit(relativePath);
}
