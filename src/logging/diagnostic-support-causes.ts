import { SQLITE_SNAPSHOT_STABILIZATION_DETAILS } from "../infra/sqlite-snapshot-diagnostics.js";

/** Extract only closed causes from already sanitized diagnostic lines. */
export function readPublicSupportCauses(value: string): string[] {
  return (
    value.match(
      /\b(?:GLIBC_\d{1,3}(?:\.\d{1,3}){1,2} not found|[Cc]onnection (?:refused|closed|timed out)|[Pp]ermission denied|[Nn]o space left on device|MCP error -?\d{1,5}|HTTP [1-5]\d{2}|Invalid package dist content inventory|SQLite (?:snapshot (?:hash|size) mismatch|file generation (?:changed while reading|did not stabilize)|source did not stabilize|WAL commit (?:header is unavailable or changing|publication could not be verified))|Package rollback (?:launcher backup changed|verification (?:timed out|failed))|attempt state write refused|sentinel transaction (?:refused|unavailable)|pipe closed|managed update handoff (?:exited before (?:responding|signaling readiness)|did not (?:respond|signal readiness)))\b/gu,
    ) ?? []
  )
    .map((cause) => cause.replace(/^permission denied$/u, "Permission denied"))
    .concat(value.match(SQLITE_SNAPSHOT_STABILIZATION_DETAILS) ?? [])
    .concat(
      // Volume roles and formatted capacities contain no private paths or identifiers.
      value.match(
        /^Update database (?:backup|rollback|capture) volume: needs \d{1,8}(?:\.\d)? (?:MiB|GiB); available \d{1,8}(?:\.\d)? (?:MiB|GiB)$/gmu,
      ) ?? [],
    );
}
