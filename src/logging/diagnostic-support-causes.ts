import { SQLITE_SNAPSHOT_STABILIZATION_DETAILS } from "../infra/sqlite-snapshot-diagnostics.js";

/** Extract closed causes; matches are fixed phrases and bounded numbers, never surrounding text. */
export function readPublicSupportCauses(value: string): string[] {
  return (
    value.match(
      /\b(?:GLIBC_\d{1,3}(?:\.\d{1,3}){1,2} not found|[Cc]onnection (?:refused|closed|timed out|reset by peer)|[Pp]ermission denied(?: \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic|gssapi-keyex)(?:,(?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic|gssapi-keyex)){0,5}\))?|[Nn]o space left on device|MCP error -?\d{1,5}|HTTP [1-5]\d{2}|Invalid package dist content inventory|SQLite (?:snapshot (?:hash|size) mismatch|file generation (?:changed while reading|did not stabilize)|source did not stabilize|WAL commit (?:header is unavailable or changing|publication could not be verified))|Package rollback (?:launcher backup changed|verification (?:timed out|failed))|attempt state write refused|sentinel transaction (?:refused|unavailable)|pipe closed|managed update handoff (?:exited before (?:responding|signaling readiness)|did not (?:respond|signal readiness))|Could not resolve host(?:name)?|Temporary failure in name resolution|Name or service not known|[Nn]etwork is unreachable|Failed to connect|Couldn't connect to server|[Oo]peration timed out|SSL certificate problem|server certificate verification failed|gnutls_handshake\(\) failed|[Uu]nable to access|Authentication failed|terminal prompts disabled|[Rr]epository not found|The requested URL returned error: [1-5]\d{2}|Could not read from remote repository|remote end hung up unexpectedly|RPC failed|early EOF|unexpected disconnect while reading sideband packet|index-pack failed|not a git repository|already exists and is not an empty directory|would be overwritten by (?:merge|checkout)|CONFLICT \((?:content|add\/add|modify\/delete|delete\/modify|rename\/delete|rename\/rename|rename\/add|file\/directory|directory\/file|distinct types|submodule)\))(?!\w)/gu,
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
