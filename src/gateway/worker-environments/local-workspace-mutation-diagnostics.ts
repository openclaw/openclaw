import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { LocalWorkspaceMutation } from "./local-workspace-store.types.js";

const log = createSubsystemLogger("agents/worktrees");
let nextOversizedMutationLogAt = 0;
const shortDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export function warnOversizedMutation(
  mutation: LocalWorkspaceMutation,
  serializedBytes: number,
  wireBytes: number,
  correlation: Record<string, string>,
) {
  if (serializedBytes <= 1024 * 1024 || Date.now() < nextOversizedMutationLogAt) {
    return;
  }
  nextOversizedMutationLogAt = Date.now() + 60_000;
  const patch: Record<string, unknown> =
    mutation.kind === "create" ? mutation.row : mutation.kind === "update" ? mutation.patch : {};
  const bytes = (value: unknown) =>
    typeof value === "string"
      ? Buffer.byteLength(value)
      : value instanceof Uint8Array
        ? value.byteLength
        : typeof value === "number"
          ? 8
          : 0;
  const fields = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, bytes(value)]),
  );
  // Inspect only the rate-limited diagnostic sample; never serialize the payload again.
  const document = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        // Diagnostics must not change mutation or recovery behavior.
      }
    }
    return {};
  };
  const journal = document(patch.journal_json);
  const checkpoint = document(patch.checkpoint_json);
  const fingerprints =
    mutation.kind === "update" && mutation.manifest?.fingerprints
      ? mutation.manifest.fingerprints
      : isRecord(checkpoint.fingerprints)
        ? checkpoint.fingerprints
        : {};
  const blobs = [fingerprints.blob, fingerprints.oppositeBlob].filter(
    (value) => typeof value === "string",
  );
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  // Recovery's producer already hashes these exact pack bytes; do not scan them again here.
  const packDigest =
    typeof journal.basePackSha256 === "string" && /^[a-f0-9]{64}$/u.test(journal.basePackSha256)
      ? journal.basePackSha256.slice(0, 16)
      : "-";
  log.warn(
    `Local workspace oversized mutation: kind=${mutation.kind} serializedBytes=${serializedBytes} wireBytes=${wireBytes} fieldBytes=${JSON.stringify(fields)} manifestFingerprintCount=${blobs.length} manifestFingerprintBytes=${blobs.reduce((sum, blob) => sum + bytes(blob), 0)} journalBaseEntries=${count(journal.baseEntries)} journalAppliedEntries=${count(journal.appliedEntries)} journalBaseDirectories=${count(journal.baseDirectories)} journalAppliedDirectories=${count(journal.appliedDirectories)} journalBaseTreeBytes=${bytes(journal.baseTree)}` +
      ` correlation=${JSON.stringify(correlation)} journalPackSha256=${packDigest} journalJsonSha256=${typeof patch.journal_json === "string" ? shortDigest(patch.journal_json) : "-"}`,
  );
}
