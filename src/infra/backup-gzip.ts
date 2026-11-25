import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { exclusiveBytes } from "./backup-gzip-bytes.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const compressOnLibuv = promisify(gzip);

// Members share no dictionary, so a block must dwarf deflate's 32 KiB window
// to keep the archive size within a fraction of a percent of one stream.
const BLOCK_BYTES = 4 * 1024 * 1024;
// zlib runs on the libuv pool, four threads unless the operator resized it.
// The traversal's file reads share that pool; a larger window would only queue.
const LIBUV_CONCURRENCY = 4;
// Past that, blocks compress on worker threads, off the libuv pool. Two cores
// stay free for the tar walk and the writer, which keep up with about eight
// workers; more only add memory and CPU.
const MAX_WORKERS = 8;
const RESERVED_CORES = 2;

function resolveGzipConcurrency(): number {
  const cores = availableParallelism();
  return Math.max(
    Math.min(LIBUV_CONCURRENCY, cores),
    Math.min(MAX_WORKERS, cores - RESERVED_CORES),
  );
}

function createWorkerCompressor(workers: number) {
  const pool = new WorkerTaskPool<Uint8Array<ArrayBuffer>, Uint8Array>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.backupGzip),
    maxWorkers: workers,
  });
  return {
    compress: async (block: Buffer) => {
      // Cloning a view copies its whole backing store; move an owned copy instead.
      const member = await pool.run(exclusiveBytes(block), {
        inputBytes: block.length,
        transferList: (input) => [input.buffer],
      });
      return Buffer.from(member.buffer, member.byteOffset, member.byteLength);
    },
    close: () => pool.close(),
  };
}

/**
 * Compress a byte stream as consecutive gzip members, several blocks at a time.
 *
 * RFC 1952 defines a gzip file as a series of members, so the output is an
 * ordinary `.tar.gz` for every existing reader. Order is preserved.
 */
export async function* gzipInParallel(
  source: AsyncIterable<Buffer>,
  concurrency = resolveGzipConcurrency(),
): AsyncGenerator<Buffer> {
  const workers = concurrency > LIBUV_CONCURRENCY ? createWorkerCompressor(concurrency) : undefined;
  const compress = workers?.compress ?? compressOnLibuv;
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
    await workers?.close();
  }
}
