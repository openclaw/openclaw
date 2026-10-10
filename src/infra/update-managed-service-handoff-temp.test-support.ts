import fs from "node:fs/promises";
import path from "node:path";

/** Validate every target before removing any fixture-owned directory. */
export async function cleanupManagedHandoffTempDirs(dirs: Iterable<string>, root: string) {
  const owner = await fs.realpath(root);
  const targets = [...dirs];
  const assertWithinRoot = (target: string) => {
    const relative = path.relative(owner, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Refusing handoff cleanup outside fixture root: ${target}`);
    }
  };
  for (const dir of targets) {
    if (!path.isAbsolute(dir)) {
      throw new Error(`Refusing non-absolute handoff cleanup directory: ${dir}`);
    }
    assertWithinRoot(path.resolve(dir));
    let target: string;
    try {
      target = await fs.realpath(dir);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      target = path.resolve(dir);
    }
    assertWithinRoot(target);
  }
  await Promise.all(targets.map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
