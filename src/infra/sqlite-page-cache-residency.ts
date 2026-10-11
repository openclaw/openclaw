import fs from "node:fs";
import { createRequire } from "node:module";

export type SqlitePageCacheResidency = {
  scope: "file-sample";
  sampledPages: number;
  residentPages: number;
  residentRatio: number;
  pageSize: number;
  sizeBytes: number;
};

let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const libc = koffi.load(null);
  const mmap = libc.func(
    "void *mmap(void *address, size_t length, int protection, int flags, int fd, int64_t offset)",
  );
  const mincore = libc.func("int mincore(void *address, size_t length, _Out_ uint8_t *vector)");
  const munmap = libc.func("int munmap(void *address, size_t length)");
  const pageSize: number = libc.func("int getpagesize()")();
  const fail = (operation: string) => {
    throw new Error(`SQLite page-cache ${operation} failed (errno ${koffi.errno()})`);
  };
  return {
    pageSize,
    resident(fd: number, offset: number): boolean {
      // PROT_NONE + MAP_PRIVATE observes residency without faulting file contents into memory.
      const mapping: unknown = mmap(null, pageSize, 0, 2, fd, offset);
      if (mapping === null || BigInt.asIntN(64, koffi.address(mapping)) === -1n) {
        fail("mmap");
      }
      try {
        const vector = Buffer.alloc(1);
        if (mincore(mapping, pageSize, vector) !== 0) {
          fail("mincore");
        }
        return (vector[0]! & 1) === 1;
      } finally {
        if (munmap(mapping, pageSize) !== 0) {
          fail("munmap");
        }
      }
    },
  };
}

/** Worker-only, bounded file residency sample; it does not identify SQLite's logical hot set. */
export function readSqlitePageCacheResidency(
  pathname: string,
): SqlitePageCacheResidency | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  native ??= loadNative();
  const fd = fs.openSync(pathname, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("SQLite page-cache residency requires a regular file");
    }
    const pageCount = Math.ceil(stat.size / native.pageSize);
    const sampledPages = Math.min(256, pageCount);
    let residentPages = 0;
    for (let index = 0; index < sampledPages; index++) {
      const page = Math.floor((index * (pageCount - 1)) / Math.max(1, sampledPages - 1));
      if (native.resident(fd, page * native.pageSize)) {
        residentPages++;
      }
    }
    return {
      scope: "file-sample",
      sampledPages,
      residentPages,
      residentRatio: sampledPages === 0 ? 1 : residentPages / sampledPages,
      pageSize: native.pageSize,
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
