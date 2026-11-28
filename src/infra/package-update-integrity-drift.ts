import type { BigIntStats } from "node:fs";

// Stat comparison and metadata-only drift policy for package tree scans.
const STAT_FIELDS = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;

export function packageStatUnchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && STAT_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Attribute, ACL and extended-attribute writes, same-mode chmod and hard-link
 * changes move only the change time and link count. A content write also moves
 * size or mtime, so such drift is accepted only after the bytes are confirmed.
 */
export function packageStatMetadataOnlyDrift(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino !== 0n &&
    STAT_FIELDS.every(
      (field) => field === "nlink" || field === "ctimeNs" || left[field] === right[field],
    )
  );
}

export function packageStatChanges(stat: BigIntStats, current: BigIntStats) {
  const fields = STAT_FIELDS.filter((field) => stat[field] !== current[field]);
  const changes = Object.fromEntries(
    fields.map((field) => [field, { before: String(stat[field]), after: String(current[field]) }]),
  );
  return { fields, changes: JSON.stringify(changes) };
}

export type PackageMetadataDrift = {
  file: string;
  relative: string;
  stat: BigIntStats;
  current: BigIntStats;
};

export type PackageMetadataDriftChange = "contents" | "target" | "children";

type Observation = { file: string; stat: BigIntStats };

/**
 * Final sweep of a package tree scan: every observed entry must still match
 * its stat. Backup, sync, indexing and security tools change attributes
 * without writing bytes, so drift in only the change time or link count
 * re-reads that entry, after every strict refusal and in traversal order, and
 * is accepted when the bytes, link target or entry names the scan recorded
 * still hold. If an indexer touched every entry, this repeats the scan's
 * reads once under the reader's deadline. Accepted observations take the new
 * stat so later owner checks compare it.
 */
export async function sweepPackageTreeObservations(
  observed: readonly Observation[],
  io: {
    acceptMetadataDrift: boolean;
    relative: (file: string) => string;
    lstat: (file: string) => Promise<BigIntStats>;
    refuse: (
      relative: string,
      stat: BigIntStats,
      current: BigIntStats,
      change?: PackageMetadataDriftChange,
    ) => Error;
    recorded: (relative: string) => ReadonlyMap<string, string> | undefined;
    hash: (file: string, stat: BigIntStats) => Promise<string>;
    readlink: (file: string) => Promise<string>;
    children: (relative: string) => readonly string[];
    entries: (directory: string) => Promise<string[]>;
  },
): Promise<PackageMetadataDrift[]> {
  const changed = async ({ file, relative, current }: PackageMetadataDrift) => {
    if (current.isFile()) {
      // npm's hidden lockfile is outside the digest and records no bytes.
      const expected = io.recorded(relative)?.get("sha256");
      const actual = expected && (await io.hash(file, current));
      return actual === expected ? undefined : "contents";
    }
    if (current.isSymbolicLink()) {
      const target = await io.readlink(file);
      return target === io.recorded(relative)?.get("target") ? undefined : "target";
    }
    const before = io.children(relative);
    const after = await io.entries(file);
    return after.length === before.length && after.every((name, at) => name === before[at])
      ? undefined
      : "children";
  };
  const drifted: Array<PackageMetadataDrift & { observation: Observation }> = [];
  for (let start = 0; start < observed.length; start += 32) {
    const results = await Promise.allSettled(
      observed.slice(start, start + 32).map(async (observation) => {
        const { file, stat } = observation;
        const current = await io.lstat(file);
        if (packageStatUnchanged(stat, current)) {
          return undefined;
        }
        const relative = io.relative(file);
        if (!io.acceptMetadataDrift || !packageStatMetadataOnlyDrift(stat, current)) {
          throw io.refuse(relative, stat, current);
        }
        return { file, relative, stat, current, observation };
      }),
    );
    // Preserve traversal-order refusals, even when a later read times out first.
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      if (result.value) {
        drifted.push(result.value);
      }
    }
  }
  for (let start = 0; start < drifted.length; start += 32) {
    const batch = drifted.slice(start, start + 32);
    const results = await Promise.allSettled(batch.map(changed));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      if (result.value) {
        const { relative, stat, current } = batch[index]!;
        throw io.refuse(relative, stat, current, result.value);
      }
    }
  }
  for (const entry of drifted) {
    entry.observation.stat = entry.current;
  }
  return drifted;
}

export function formatPackageMetadataDriftWarning(drifted: readonly PackageMetadataDrift[]) {
  const first = drifted
    .slice(0, 3)
    .map(
      ({ relative, stat, current }) =>
        `entry=${JSON.stringify(relative || ".")}; changes=${packageStatChanges(stat, current).changes}`,
    );
  return `Package metadata changed during verification on ${drifted.length} ${
    drifted.length === 1 ? "entry" : "entries"
  } whose contents, size, type and mode are unchanged; accepted after re-reading them. ${first.join(" | ")}`;
}
