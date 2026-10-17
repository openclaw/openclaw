import fs from "node:fs";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import {
  MAX_TASK_ARCHIVE_RECORD_BYTES,
  TASK_ARCHIVE_RECORD_CAPACITY_ERROR,
  readTranscriptArchiveRecords,
} from "../config/sessions/session-accessor.sqlite-archive-stream.js";
import {
  transcriptEventJsonMayOverlapRange,
  type SessionTranscriptEventTimeRange,
} from "../config/sessions/transcript-event-time.js";

export async function transcriptSourceOverlapsRange(
  sourcePath: string,
  range: SessionTranscriptEventTimeRange,
): Promise<boolean> {
  const compressed = sourcePath.endsWith(".zst");
  // SAFETY: Node versions without the optional zstd API are rejected before invocation.
  const createZstdDecompress = (zlib as Partial<typeof zlib>).createZstdDecompress;
  if (compressed && !createZstdDecompress) {
    throw new Error("Cannot scan compressed transcript archive: this runtime lacks zstd support");
  }
  const input = fs.createReadStream(sourcePath);
  const output = compressed ? createZstdDecompress!.call(zlib) : new PassThrough();
  const completed = pipeline(input, output);
  let overlapsRange = false;
  try {
    for await (const record of readTranscriptArchiveRecords(
      output,
      MAX_TASK_ARCHIVE_RECORD_BYTES,
    )) {
      if (transcriptEventJsonMayOverlapRange(record.toString("utf8"), range)) {
        overlapsRange = true;
        break;
      }
    }
    if (!overlapsRange) {
      await completed;
    }
    return overlapsRange;
  } catch (error) {
    if (error instanceof Error && error.message === TASK_ARCHIVE_RECORD_CAPACITY_ERROR) {
      return true;
    }
    throw error;
  } finally {
    input.destroy();
    output.destroy();
    await completed.catch(() => undefined);
  }
}
