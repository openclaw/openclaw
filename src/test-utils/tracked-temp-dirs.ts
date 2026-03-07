import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createTrackedTempDirs() {
  const prefixRoots = new Map<string, { root: string; nextIndex: number }>();
  const pendingPrefixRoots = new Map<string, Promise<{ root: string; nextIndex: number }>>();
  const cleanupRoots = new Set<string>();
  let globalDirIndex = 0;

  const ensurePrefixRoot = async (prefix: string) => {
    const cached = prefixRoots.get(prefix);
    if (cached) {
      return cached;
    }
    const pending = pendingPrefixRoots.get(prefix);
    if (pending) {
      return await pending;
    }
    const create = (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      const state = { root, nextIndex: 0 };
      prefixRoots.set(prefix, state);
      cleanupRoots.add(root);
      return state;
    })();
    pendingPrefixRoots.set(prefix, create);
    try {
      return await create;
    } finally {
      pendingPrefixRoots.delete(prefix);
    }
  };

  return {
    async make(prefix: string): Promise<string> {
      const state = await ensurePrefixRoot(prefix);
      const dir = path.join(state.root, `dir-${String(globalDirIndex)}`);
      state.nextIndex += 1;
      globalDirIndex += 1;
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(): Promise<void> {
      const roots = [...cleanupRoots];
      cleanupRoots.clear();
      prefixRoots.clear();
      pendingPrefixRoots.clear();
      await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    },
  };
}
