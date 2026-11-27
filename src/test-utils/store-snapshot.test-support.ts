import fs from "node:fs";
import path from "node:path";

/**
 * Every file under root with its bytes and modification time. SQLite -shm is read state, and
 * opening a WAL database can leave an empty -wal; any write leaves frames in it or changes the
 * database itself.
 */
export function snapshotStoreFiles(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
      return;
    }
    if (pathname.endsWith("-shm") || (pathname.endsWith("-wal") && stat.size === 0n)) {
      return;
    }
    const bytes = stat.isFile() ? fs.readFileSync(pathname).toString("base64") : "";
    entries[path.relative(root, pathname)] =
      `${stat.mtimeNs}:${stat.mode}:${bytes.length}:${bytes}`;
  };
  visit(root);
  return entries;
}

/** Files that differ, appeared or disappeared between two snapshots. */
export function changedStoreFiles(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (file) => before[file] !== after[file],
  );
}
