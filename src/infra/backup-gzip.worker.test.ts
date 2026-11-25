import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exclusiveBytes } from "./backup-gzip-bytes.js";
import { gzipInParallel } from "./backup-gzip.js";
import type { WorkerTaskOptions, WorkerTaskPoolOptions } from "./worker-task-pool.types.js";

const BLOCK_BYTES = 4 * 1024 * 1024;
const pools = vi.hoisted(() => ({ created: new Array<number>(), closed: 0, failure: "" }));
const cores = vi.hoisted(() => ({ available: 0 }));
const workers = vi.hoisted(() => [] as Worker[]);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    availableParallelism: () => cores.available || actual.availableParallelism(),
  };
});
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerConstructors } = await import("../../test/helpers/worker-observer.js");
  return observeWorkerConstructors(actual, workers);
});

// Keep the real pool and transport; substitute only the explicit failure boundary.
vi.mock("./worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-task-pool.js")>();
  class CountedPool extends actual.WorkerTaskPool<Uint8Array<ArrayBuffer>, Uint8Array> {
    constructor(options: WorkerTaskPoolOptions<Uint8Array>) {
      super({
        ...options,
        ...(pools.failure === "startup"
          ? { workerUrl: new URL("./missing-gzip-worker.mjs", import.meta.url) }
          : pools.failure === "exit"
            ? { workerUrl: new URL("data:text/javascript,process.exit(23)") }
            : {}),
      });
      pools.created.push(options.maxWorkers ?? 0);
    }
    override run(
      input: Uint8Array<ArrayBuffer>,
      options: WorkerTaskOptions<Uint8Array<ArrayBuffer>>,
    ) {
      if (Buffer.from(input).subarray(0, 10).toString() === "fail-block") {
        return Promise.reject(new Error("worker block failed"));
      }
      return super.run(input, options);
    }
    override async close(error?: Error) {
      await super.close(error);
      pools.closed += 1;
    }
  }
  return { ...actual, WorkerTaskPool: CountedPool };
});

beforeEach(() => {
  cores.available = 0;
  pools.created = [];
  pools.closed = 0;
  pools.failure = "";
});
afterEach(() => {
  for (const worker of workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
});

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}

it("keeps small hosts on libuv and leaves two cores free past six cores", async () => {
  const widths: number[][] = [];
  for (const available of [1, 2, 4, 6, 7, 8, 12, 18, 32, 128]) {
    cores.available = available;
    pools.created = [];
    const members = await collect(gzipInParallel(Readable.from([])));
    expect(gunzipSync(Buffer.concat(members)).length).toBe(0);
    widths.push(pools.created);
  }
  expect(widths).toEqual([[], [], [], [], [5], [6], [8], [8], [8], [8]]);
});

it("only copies bytes that share a backing store", () => {
  const owned = new Uint8Array(new ArrayBuffer(8));
  const shared = Buffer.from("....tiny....").subarray(4, 8);
  expect(exclusiveBytes(owned).buffer).toBe(owned.buffer);
  const copy = exclusiveBytes(shared);
  expect(copy.buffer).not.toBe(shared.buffer);
  expect(copy.byteLength).toBe(copy.buffer.byteLength);
  expect(Buffer.from(copy).toString()).toBe("tiny");
});

it("compresses ordered members on real workers without detaching caller bytes", async () => {
  const input = [randomBytes(9 * BLOCK_BYTES + 3), randomBytes(2)];
  const snapshot = Buffer.concat(input);
  const members = await collect(gzipInParallel(Readable.from(input), 6));
  expect(pools.created).toEqual([6]);
  expect(workers).toHaveLength(6);
  expect(pools.closed).toBe(1);
  expect(gunzipSync(Buffer.concat(members)).equals(snapshot)).toBe(true);
  expect(members.map((member) => gunzipSync(member).length)).toEqual([
    ...Array.from({ length: 9 }, () => BLOCK_BYTES),
    5,
  ]);
  expect(Buffer.concat(input).equals(snapshot)).toBe(true);
});

it("bounds read-ahead and joins workers when the consumer aborts", async () => {
  let pulled = 0;
  async function* source() {
    for (let index = 0; index < 10; index += 1) {
      pulled += 1;
      yield Buffer.alloc(BLOCK_BYTES, index);
    }
  }
  const members = gzipInParallel(source(), 5);
  const observed: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    expect(gunzipSync((await members.next()).value)[0]).toBe(index);
    observed.push(pulled);
  }
  await members.return(undefined);
  expect(observed).toEqual([5, 6, 7]);
  expect(pools.closed).toBe(1);
});

it("reports failed blocks in order, closes the source and joins the pool", async () => {
  let closed = false;
  async function* source() {
    try {
      for (const fill of ["first", "fail-block", "third", "fourth", "fifth", "sixth"]) {
        yield Buffer.alloc(BLOCK_BYTES, fill);
      }
    } finally {
      closed = true;
    }
  }
  const members = gzipInParallel(source(), 5);
  expect(
    gunzipSync((await members.next()).value)
      .subarray(0, 5)
      .toString(),
  ).toBe("first");
  await expect(members.next()).rejects.toThrow("worker block failed");
  expect(closed).toBe(true);
  expect(pools.closed).toBe(1);
  expect((await members.next()).done).toBe(true);
});

it.each(["startup", "exit"])(
  "closes the source and workers after real worker %s failure",
  async (failure) => {
    pools.failure = failure;
    let closed = false;
    async function* source() {
      try {
        for (let index = 0; index < 10; index += 1) {
          yield Buffer.alloc(BLOCK_BYTES, index);
        }
      } finally {
        closed = true;
      }
    }
    await expect(collect(gzipInParallel(source(), 5))).rejects.toThrow();
    expect(closed).toBe(true);
    expect(pools.closed).toBe(1);
  },
);
