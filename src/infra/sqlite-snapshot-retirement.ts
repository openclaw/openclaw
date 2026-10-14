import fs from "node:fs";
import path from "node:path";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "./sqlite-staging-token.js";

export const SQLITE_SNAPSHOT_PREFIX = "openclaw-sqlite-readonly-v2-";
const suffix = "(?:[A-Za-z0-9]{6}|[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12})$";
export const SQLITE_SNAPSHOT_LEGACY_MARKER = new RegExp(
  `^openclaw-sqlite-readonly-[1-9]\\d*-${suffix}`,
  "u",
);
const tokenMarker = new RegExp(`^${SQLITE_SNAPSHOT_PREFIX}${suffix}`, "u");
export const SQLITE_SNAPSHOT_LEGACY_AGE_MS = 24 * 60 * 60 * 1000;
function releaseTokens(tokens: Iterable<SqliteStagingToken>): void {
  const failures: unknown[] = [];
  for (const token of tokens) {
    try {
      token();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "SQLite snapshot retirement token release failed");
  }
}

export const isSqliteSnapshotStagingName = (name: string) =>
  SQLITE_SNAPSHOT_LEGACY_MARKER.test(name) || tokenMarker.test(name);

export function acquireSqliteSnapshotToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
): SqliteStagingToken {
  return acquireSqliteStagingToken(directory, mode, {
    allowMissing: SQLITE_SNAPSHOT_LEGACY_MARKER.test(path.basename(directory)),
  });
}

/** Hold every nested lifetime before selecting payload; a parent lock alone cannot fence children. */
export function beginSqliteSnapshotRetirement(
  directory: string,
  options: { token?: SqliteStagingToken; cutoff?: number } = {},
) {
  const tokens: SqliteStagingToken[] = [];
  const payload: string[] = [];
  // Keep the registered creator retryable after failed EXCLUSIVE admission;
  // newly acquired handles instead belong to this retirement's release custody.
  const release = () => releaseTokens(tokens.filter((token) => token !== options.token));
  if (!fs.existsSync(directory)) {
    options.token?.();
    return { bytes: 0, payload, release, retire: () => {} };
  }
  function inspect(
    current: string,
    inheritedCutoff: number,
    layout = "",
    lock = true,
  ): { bytes: number; newest: number } {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Snapshot directory ownership is unknown");
    }
    const legacy = !layout && SQLITE_SNAPSHOT_LEGACY_MARKER.test(path.basename(current));
    // Owned cleanup follows joined work; abandoned legacy workers instead retain
    // their full grace period, even below a current-generation parent.
    const cutoff =
      options.cutoff !== undefined && legacy
        ? Math.min(inheritedCutoff, Date.now() - SQLITE_SNAPSHOT_LEGACY_AGE_MS)
        : inheritedCutoff;
    if (legacy && lock && options.cutoff !== undefined) {
      inspect(current, cutoff, layout, false);
    }
    if (!layout && lock) {
      tokens.push(
        current === directory && options.token
          ? options.token.beginRetirement()
          : acquireSqliteSnapshotToken(current, "reclaim"),
      );
    }
    let bytes = 0;
    let newest = stat.mtimeMs;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      const item = fs.lstatSync(location);
      if (process.getuid && item.uid !== process.getuid()) {
        throw new Error("Snapshot file ownership is unknown");
      }
      if (
        (!layout || options.cutoff === undefined) &&
        item.isFile() &&
        SQLITE_STAGING_TOKEN_FILES.some((file) => file === entry.name)
      ) {
        continue;
      }
      newest = Math.max(newest, item.mtimeMs);
      if (item.isDirectory()) {
        const nested = isSqliteSnapshotStagingName(entry.name);
        const childLayout = nested ? "" : [layout, entry.name].filter(Boolean).join("/");
        if (
          options.cutoff !== undefined &&
          ((!nested &&
            !["openclaw", "openclaw-state", "openclaw-state/state"].includes(childLayout)) ||
            (nested && layout !== "" && layout !== "openclaw"))
        ) {
          throw new Error("Unrecognized snapshot directory");
        }
        const child = inspect(location, cutoff, childLayout, lock);
        bytes += child.bytes;
        newest = Math.max(newest, child.newest);
      } else if (
        options.cutoff === undefined ||
        (item.isFile() &&
          (layout === "openclaw-state/state"
            ? /^openclaw\.sqlite(?:-wal|-shm|-journal)?$/u.test(entry.name)
            : !layout &&
              /^(?:first|database\.sqlite(?:\.partial)?(?:-wal|-shm|-journal)?)$/u.test(
                entry.name,
              )))
      ) {
        bytes += item.size;
        if (lock) {
          payload.push(location);
        }
      } else {
        throw new Error("Unrecognized snapshot artifact");
      }
    }
    if (newest >= cutoff) {
      throw new Error(
        legacy
          ? "Legacy snapshot contains activity newer than 24 hours"
          : "Snapshot contains activity within the reclamation grace period",
      );
    }
    return { bytes, newest };
  }
  try {
    const { bytes } = inspect(directory, options.cutoff ?? Number.POSITIVE_INFINITY);
    return {
      bytes,
      payload,
      release,
      retire: () => {
        // Publish retirement before closing the controls and removing their directory.
        for (const token of tokens) {
          token(true);
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
