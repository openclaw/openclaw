// Aggregate ceiling for the materialized session archive read cache.
//
// Per-entry TTL alone still lets a busy gateway materialize every archive it
// touches within a day, which is how /tmp filled with hundreds of decompressed
// copies (#193193). This budget bounds total retained plaintext, and the cache
// evicts least-recently-materialized entries first.
//
// Fixed rather than configurable: the archive reader is not tuned per
// deployment, and a new OPENCLAW_* name spends a repo-wide budget slot.
export const materializedArchiveCacheBudgetBytes = 256 * 1024 * 1024;
