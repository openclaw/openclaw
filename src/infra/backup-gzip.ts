import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);

// Members share no dictionary, so a block must dwarf deflate's 32 KiB window
// to keep the archive size within a fraction of a percent of one stream.
const BLOCK_BYTES = 4 * 1024 * 1024;
// zlib runs on the libuv pool, four threads unless the operator resized it.
// The traversal's file reads share that pool; a larger window would only queue.
const MAX_CONCURRENCY = 4;

/**
 * Compress a byte stream as consecutive gzip members, several blocks at a time.
 *
 * RFC 1952 defines a gzip file as a series of members, so the output is an
 * ordinary `.tar.gz` for every existing reader. Order is preserved.
 */
export async function* gzipInParallel(
  source: AsyncIterable<Buffer>,
  concurrency = Math.min(MAX_CONCURRENCY, availableParallelism()),
): AsyncGenerator<Buffer> {
  const pending: Array<Promise<Buffer>> = [];
  let parts: Buffer[] = [];
  let size = 0;
  let submitted = false;
  const submit = () => {
    const member = compress(Buffer.concat(parts, size));
    // The consumer observes the rejection in order; a later block must not
    // surface first as an unhandled rejection.
    member.catch(() => undefined);
    pending.push(member);
    submitted = true;
    parts = [];
    size = 0;
  };
  try {
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length;) {
        const part = chunk.subarray(offset, offset + BLOCK_BYTES - size);
        parts.push(part);
        size += part.length;
        offset += part.length;
        if (size === BLOCK_BYTES) {
          submit();
          if (pending.length >= concurrency) {
            yield await pending.shift()!;
          }
        }
      }
    }
    // Empty input still needs one member to be a gzip file.
    if (size > 0 || !submitted) {
      submit();
    }
    while (pending.length > 0) {
      yield await pending.shift()!;
    }
  } finally {
    // A cancelled or failed archive settles only after its in-flight blocks do.
    await Promise.allSettled(pending);
  }
}
