// Allow records above the RPC page budget without unbounded parsing amplification.
export const MAX_TASK_ARCHIVE_RECORD_BYTES = 8 * 1024 * 1024;
const TASK_ARCHIVE_RECORD_CAPACITY_ERROR =
  "Archived transcript is unavailable because a record exceeds the task-history read capacity.";

/** Frame JSONL and retained multiline JSON as bytes; the caller owns strict JSON validation. */
export async function* readTranscriptArchiveRecords(
  source: AsyncIterable<Uint8Array>,
  maxRecordBytes?: number,
) {
  let fragments: Uint8Array[] = [];
  let bytes = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let hasContent = false;
  for await (const chunk of source) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === 10 && (depth <= 0 || quoted)) {
        fragments.push(chunk.subarray(start, index));
        bytes += index - start;
        if (hasContent) {
          yield Buffer.concat(fragments, bytes);
        }
        fragments = [];
        bytes = 0;
        depth = 0;
        quoted = false;
        escaped = false;
        hasContent = false;
        start = index + 1;
        continue;
      }
      if (maxRecordBytes !== undefined && bytes + index - start + 1 > maxRecordBytes) {
        throw new Error(TASK_ARCHIVE_RECORD_CAPACITY_ERROR);
      }
      if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        hasContent = true;
      }
      if (escaped) {
        escaped = false;
      } else if (quoted && byte === 92) {
        escaped = true;
      } else if (byte === 34) {
        quoted = !quoted;
      } else if (!quoted) {
        if (byte === 123 || byte === 91) {
          depth += 1;
        } else if (byte === 125 || byte === 93) {
          depth -= 1;
        }
      }
    }
    if (start < chunk.byteLength) {
      fragments.push(chunk.subarray(start));
      bytes += chunk.byteLength - start;
    }
  }
  if (hasContent) {
    yield Buffer.concat(fragments, bytes);
  }
}
