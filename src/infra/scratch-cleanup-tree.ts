import path from "node:path";
import { root as openRoot, type Root } from "@openclaw/fs-safe/root";

type ScratchStat = Awaited<ReturnType<Root["stat"]>>;
export type ScratchTreeRequest = {
  type: "scratch";
  decision: SharedArrayBuffer;
  root: string;
  relativePath: string;
  identity: Pick<ScratchStat, "dev" | "ino" | "exactIdentity">;
  cutoff: number;
  remaining: number;
  remove: boolean;
  removedBefore: number;
};
export type ScratchTreeResult = {
  type: "scratch";
  newest: number;
  visited: number;
  filesRemoved: number;
  bytesRemoved: number;
  error?: string;
  retry?: boolean;
};
export const SCRATCH_MAX_ENTRIES = 2_000_000;
export const SCRATCH_DELETE_BATCH_SIZE = 128;

/** Recursive filesystem work stays in the filesystem isolate; admission stays with its caller. */
export async function walkScratchTree(
  command: ScratchTreeRequest,
  assertCurrent: () => void,
  pause: (progress: ScratchTreeResult) => Promise<void>,
): Promise<ScratchTreeResult> {
  const result: ScratchTreeResult = {
    type: "scratch",
    newest: -Infinity,
    visited: 0,
    filesRemoved: 0,
    bytesRemoved: 0,
  };
  try {
    const root = await openRoot(command.root, { symlinks: "reject" });
    if (root.rootReal !== path.resolve(command.root)) {
      throw new Error("scratch root uses a symlink; entry retained");
    }
    const entryStat = await root.stat(command.relativePath);
    const expected = command.identity.exactIdentity ?? command.identity;
    const observed = command.identity.exactIdentity ? entryStat.exactIdentity : entryStat;
    if (!observed || observed.dev !== expected.dev || observed.ino !== expected.ino) {
      throw new Error("scratch entry identity changed; entry retained");
    }
    const walk = async (
      relativePath: string,
      stat: ScratchStat,
      depth: number,
    ): Promise<number> => {
      assertCurrent();
      if (depth > 64 || result.visited >= SCRATCH_MAX_ENTRIES) {
        result.retry = false;
        throw new Error("scratch scan budget exhausted; entry retained");
      }
      if (result.visited >= command.remaining) {
        result.retry = true;
        throw new Error("scratch scan budget exhausted; entry retained");
      }
      result.visited++;
      if (!stat.isSymbolicLink && !stat.isDirectory && !stat.isFile) {
        throw new Error("scratch contains a special file; entry retained");
      }
      let newest = stat.isDirectory ? -Infinity : stat.mtimeMs;
      if (stat.isDirectory) {
        const objectDirectory = /(?:^|[/\\])\.git[/\\]objects[/\\](?:pack|[a-f0-9]{2})$/.test(
          relativePath,
        );
        for await (const child of root.entries(relativePath, {
          order: "filesystem",
          symlinks: "reject",
        })) {
          const childNewest = await walk(path.join(relativePath, child.name), child, depth + 1);
          // Refreshing a shared Git object is not activity in every linked checkout.
          newest = Math.max(
            newest,
            objectDirectory && child.isFile && child.nlink > 1 ? stat.mtimeMs : childNewest,
          );
          if (!command.remove && newest >= command.cutoff) {
            return newest;
          }
        }
      }
      if (command.remove) {
        const removed = command.removedBefore + result.filesRemoved;
        if (removed > 0 && removed % SCRATCH_DELETE_BATCH_SIZE === 0) {
          await pause(result);
        }
        await root.remove(relativePath, { assertBeforeMutation: assertCurrent });
        result.filesRemoved++;
        result.bytesRemoved += stat.isFile ? stat.size : 0;
      }
      return newest;
    };
    result.newest = await walk(command.relativePath, entryStat, 0);
  } catch (error) {
    result.error = String(error);
  }
  return result;
}
