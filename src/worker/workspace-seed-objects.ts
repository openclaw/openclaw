import type fsp from "node:fs/promises";
import type path from "node:path";

/** Self-contained so provider scripts and the native transfer owner share this boundary. */
export async function copyWorkspaceSeedGitObjects(input: {
  filesystem: Pick<typeof fsp, "mkdir" | "readdir" | "copyFile" | "lstat">;
  paths: Pick<typeof path, "join" | "relative" | "sep">;
  source: string;
  destination: string;
  maxEntries: number;
  maxBytes: number;
  assertCurrent?: () => void;
}): Promise<void> {
  let bytes = 0;
  let entries = 0;
  const pending = [{ source: input.source, destination: input.destination }];
  for (let item = pending.pop(); item; item = pending.pop()) {
    input.assertCurrent?.();
    if (input.paths.relative(input.source, item.source).split(input.paths.sep)[0] === "info") {
      continue;
    }
    const stat = await input.filesystem.lstat(item.source);
    input.assertCurrent?.();
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error("Prepared project seed contains an unsafe Git object");
    }
    bytes += stat.isFile() ? stat.size : 0;
    if (++entries > input.maxEntries || bytes > input.maxBytes) {
      throw new Error("Prepared project seed Git objects exceed the transfer limit");
    }
    if (stat.isDirectory()) {
      await input.filesystem.mkdir(item.destination, { recursive: true });
      input.assertCurrent?.();
      const names = await input.filesystem.readdir(item.source);
      input.assertCurrent?.();
      if (entries + pending.length + names.length > input.maxEntries) {
        throw new Error("Prepared project seed Git objects exceed the transfer limit");
      }
      for (const name of names) {
        pending.push({
          source: input.paths.join(item.source, name),
          destination: input.paths.join(item.destination, name),
        });
      }
    } else {
      await input.filesystem.copyFile(item.source, item.destination);
    }
  }
  input.assertCurrent?.();
}
