// Shares one { path, fingerprint } record per distinct checkout file across parsed
// session entries.
//
// A session that started operator work carries a diff baseline: the path and content
// fingerprint of every file in the workspace checkout at that moment. Sessions on one host
// share one checkout, so those records are byte-identical from row to row -- but each row
// parses its own JSON document, so each materializes its own copies, and a read that spans
// the store mints the whole set again. A few hundred rows over a few hundred tracked files
// is a six-figure object count whose entire content is a few hundred distinct pairs.
//
// Baselines are read-only once parsed: the sole consumer folds them into a
// path -> fingerprint Map to decide which diff hunks predate the session. Sharing one
// frozen instance per distinct pair is therefore observationally identical to parsing
// fresh copies, and freezing turns a future in-place write into a loud TypeError instead
// of silent cross-entry aliasing.

export type SessionDiffBaselineFileRecord = { path: string; fingerprint: string };

// One live checkout's tracked-file count, with room for a rename wave. A checkout past
// this size trips the baseline's own truncation caps long before the map matters.
const MAX_INTERNED_FILES = 4096;

// Keyed by path alone: a path holds one fingerprint at a time, so keying on the pair would
// only add a per-lookup key allocation to the hot path it is meant to relieve.
const internedFiles = new Map<string, Readonly<SessionDiffBaselineFileRecord>>();

/** Return the canonical record for `path`, adopting this pair as canonical when unseen. */
export function internDiffBaselineFile(
  path: string,
  fingerprint: string,
): Readonly<SessionDiffBaselineFileRecord> {
  const existing = internedFiles.get(path);
  if (existing?.fingerprint === fingerprint) {
    // Refresh recency so files the live checkout keeps touching outlive stale ones.
    internedFiles.delete(path);
    internedFiles.set(path, existing);
    return existing;
  }
  const adopted = Object.freeze({ fingerprint, path });
  // A changed fingerprint replaces the record; entries already holding the old one keep it.
  internedFiles.delete(path);
  internedFiles.set(path, adopted);
  while (internedFiles.size > MAX_INTERNED_FILES) {
    const oldest = internedFiles.keys().next();
    if (oldest.done) {
      break;
    }
    internedFiles.delete(oldest.value);
  }
  return adopted;
}

/** Replace an entry's diff-baseline file records with canonical instances, in place. */
export function internSessionEntryDiffBaseline(entry: {
  sessionDiffBaseline?: { files?: unknown };
}): void {
  const files = entry.sessionDiffBaseline?.files;
  if (!Array.isArray(files)) {
    return;
  }
  for (let index = 0; index < files.length; index++) {
    const file: unknown = files[index];
    if (!file || typeof file !== "object") {
      continue;
    }
    const { fingerprint, path } = file as Partial<SessionDiffBaselineFileRecord>;
    if (typeof path !== "string" || typeof fingerprint !== "string") {
      continue;
    }
    files[index] = internDiffBaselineFile(path, fingerprint);
  }
}

/** Drop interned records. Tests use this to keep cases independent. */
export function resetInternedDiffBaselineFiles(): void {
  internedFiles.clear();
}

/** Current interned record count. Exposed for tests and diagnostics. */
export function internedDiffBaselineFileCount(): number {
  return internedFiles.size;
}
