import fs from "node:fs";
import path from "node:path";

/**
 * A SQLite WAL sidecar's recorded state. A live connection rewrites `-shm` and may leave
 * an empty `-wal` in place, so their bytes are not a write by the code under test. A sidecar
 * that appears or disappears is: a read-only open of a WAL database whose sidecars are
 * absent creates both and, unable to checkpoint, leaves them behind. A `-wal` that gains
 * frames, or a changed database file, is a write.
 */
function sidecarState(pathname: string, size: bigint): string | undefined {
  if (pathname.endsWith("-shm")) {
    return "sqlite-shm";
  }
  if (pathname.endsWith("-wal") && size === 0n) {
    return "sqlite-wal:empty";
  }
  return undefined;
}

/**
 * Every file under root with its bytes and modification time; WAL sidecars by presence.
 * `ignoreReadSidecars` drops `-shm` and empty `-wal` files, for code that may read an unheld
 * store (a diagnostic) where only a write is a failure.
 */
export function snapshotStoreFiles(
  root: string,
  options: { ignoreReadSidecars?: true } = {},
): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
      return;
    }
    const relative = path.relative(root, pathname);
    const sidecar = sidecarState(pathname, stat.size);
    if (sidecar) {
      if (!options.ignoreReadSidecars) {
        entries[relative] = sidecar;
      }
      return;
    }
    const bytes = stat.isFile() ? fs.readFileSync(pathname).toString("base64") : "";
    entries[relative] = `${stat.mtimeNs}:${stat.mode}:${bytes.length}:${bytes}`;
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

/** SQLite sidecars under root, relative to it. */
export function listSqliteSidecars(root: string): string[] {
  const found: string[] = [];
  const visit = (pathname: string) => {
    if (fs.lstatSync(pathname).isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
    } else if (/-(?:wal|shm|journal)$/u.test(pathname)) {
      found.push(path.relative(root, pathname));
    }
  };
  visit(root);
  return found;
}

/**
 * Removes the empty WAL sidecars a read-only open leaves behind, as SQLite removes them when a
 * writable connection closes. Call it only after closing every connection to the stores under
 * root; a `-wal` with frames, and its `-shm`, stay.
 */
export function removeEmptySqliteSidecars(root: string): void {
  for (const file of listSqliteSidecars(root)) {
    const pathname = path.join(root, file);
    const wal = pathname.replace(/-(?:shm|wal)$/u, "-wal");
    if (!file.endsWith("-journal") && (!fs.existsSync(wal) || fs.statSync(wal).size === 0)) {
      fs.rmSync(pathname, { force: true });
    }
  }
}
