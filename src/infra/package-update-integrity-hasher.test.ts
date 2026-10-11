import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { MessageChannel, type Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPackageFileHasher,
  type PackageFileHasher,
} from "./package-update-integrity-hasher.js";

const runtime = vi.hoisted(() => ({
  parallelism: 4,
  workers: [] as Worker[],
  exits: [] as Promise<number>[],
  construct:
    vi.fn<(source: string | URL, options: WorkerOptions) => [string | URL, WorkerOptions]>(),
  debug: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => runtime.parallelism,
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: runtime.debug }),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(source: string | URL, options: WorkerOptions = {}) {
        super(...runtime.construct(source, options));
        runtime.workers.push(this);
        runtime.exits.push(
          new Promise((resolve) => {
            this.once("exit", resolve);
          }),
        );
      }
    },
  };
});

const hashers = new Set<PackageFileHasher>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const hasher of hashers) {
      hasher.close();
    }
    await Promise.all(runtime.exits);
    hashers.clear();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  runtime.parallelism = 4;
  runtime.workers.length = 0;
  runtime.exits.length = 0;
  runtime.construct.mockReset().mockImplementation((source, options) => [source, options]);
  runtime.debug.mockReset();
});

function createHasher(fallback: PackageFileHasher["hash"] = vi.fn()) {
  const hasher = createPackageFileHasher(fallback);
  hashers.add(hasher);
  return hasher;
}

async function fixture(name: string, bytes: string | Buffer = "package bytes") {
  const file = path.join(tempDirs.make("package-file-hasher-"), name);
  await fs.writeFile(file, bytes);
  return { file, stat: await fs.lstat(file, { bigint: true }) };
}

function digest(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("package file hashing workers", () => {
  it("starts lazily and hashes bytes without inherited compile-cache writes", async () => {
    const cache = tempDirs.make("package-file-hasher-cache-");
    vi.stubEnv("NODE_COMPILE_CACHE", cache);
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", undefined);
    const fallback = vi.fn();
    createHasher(fallback).close();
    const hasher = createHasher(fallback);
    expect(runtime.workers).toHaveLength(0);
    hasher.flush();
    const bytes = Buffer.from(Array.from({ length: 192 * 1024 + 17 }, (_, index) => index % 251));
    const inputs = await Promise.all([fixture("empty", ""), fixture("large", bytes)]);
    const hashes = Promise.all(inputs.map(({ file, stat }) => hasher.hash(file, stat)));
    expect(runtime.workers).toHaveLength(0);
    hasher.flush();
    expect(await hashes).toEqual([digest(""), digest(bytes)]);
    expect(await fs.readdir(cache)).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects a file changed since its admitted stat", async () => {
    const { file, stat } = await fixture("changed");
    await fs.appendFile(file, " more bytes");
    const hasher = createHasher();
    const hash = hasher.hash(file, stat);
    hasher.flush();
    await expect(hash).rejects.toThrow("Package rollback file changed before reading");
  });

  it.skipIf(process.platform === "win32")(
    "preserves ELOOP when a symlink replaces an admitted regular file",
    async () => {
      const { file, stat } = await fixture("replaced");
      const target = path.join(path.dirname(file), "target");
      await fs.rename(file, target);
      await fs.symlink(target, file);
      const hasher = createHasher();
      const hash = hasher.hash(file, stat);
      hasher.flush();
      await expect(hash).rejects.toMatchObject({
        message: expect.stringContaining("ELOOP"),
        code: "ELOOP",
        errno: expect.any(Number),
        syscall: "open",
        path: file,
      });
    },
  );

  it("preserves fs error fields when an admitted file vanishes", async () => {
    const { file, stat } = await fixture("vanished");
    await fs.unlink(file);
    const hasher = createHasher();
    const hash = hasher.hash(file, stat);
    hasher.flush();
    await expect(hash).rejects.toMatchObject({
      message: expect.stringContaining("ENOENT"),
      code: "ENOENT",
      errno: expect.any(Number),
      syscall: "open",
      path: file,
    });
  });

  it.skipIf(process.platform === "win32")(
    "close skips unstarted batch jobs and stops the active file before its next filesystem call",
    async ({ signal }) => {
      runtime.parallelism = 1;
      const inputs = await Promise.all(
        Array.from({ length: 19 }, (_, index) => fixture(`file-${index}`)),
      );
      const gate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
      const { port1, port2 } = new MessageChannel();
      const reading = createDeferred();
      port1.once("message", () => reading.resolve());
      // Instrument the real worker's fs boundary: stop after open, then observe
      // its own finally and cancellation between jobs in the same batch.
      runtime.construct.mockImplementation((source, options) => [
        `(() => {
          const fs = require("node:fs");
          const { probeGate, probePort, probeFile } = require("node:worker_threads").workerData;
          const open = fs.openSync;
          const read = fs.readSync;
          const close = fs.closeSync;
          const fstat = fs.fstatSync;
          let stopped = false;
          let targetFd;
          fs.openSync = (...args) => {
            const fd = open(...args);
            Atomics.add(probeGate, 1, 1);
            if (args[0] === probeFile) {
              targetFd = fd;
            }
            return fd;
          };
          fs.readSync = (...args) => {
            if (args[0] === targetFd && !stopped) {
              stopped = true;
              probePort.postMessage("reading");
              probePort.close();
              Atomics.wait(probeGate, 0, 0);
            }
            return read(...args);
          };
          fs.fstatSync = (...args) => {
            if (args[0] === targetFd) {
              Atomics.add(probeGate, 3, 1);
            }
            return fstat(...args);
          };
          fs.closeSync = (...args) => {
            const result = close(...args);
            Atomics.add(probeGate, 2, 1);
            return result;
          };
        })();\n${String(source)}`,
        {
          ...options,
          workerData: {
            ...options.workerData,
            probeGate: gate,
            probePort: port2,
            probeFile: inputs[1]!.file,
          },
          transferList: [port2],
        },
      ]);
      const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
      const descriptorsBefore = readdirSync(descriptorDirectory).length;
      const hasher = createHasher();
      const results = Promise.allSettled(inputs.map(({ file, stat }) => hasher.hash(file, stat)));
      hasher.flush();
      try {
        await withinTest(
          awaitGateBeforeSettlement(reading.promise, results, "worker never reached its file read"),
          signal,
        );
        hasher.close();
        expect(Atomics.load(gate, 1)).toBe(2);
        expect(Atomics.load(gate, 2)).toBe(1);
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        const settled = await results;
        await Promise.all(runtime.exits);
        expect(settled[0]).toEqual({ status: "fulfilled", value: digest("package bytes") });
        // The active file finishes its in-flight read, then starts no further I/O.
        expect(Atomics.load(gate, 3)).toBe(1);
        for (const result of settled.slice(1)) {
          expect(result).toMatchObject({
            status: "rejected",
            reason: new Error("Package file hashing cancelled"),
          });
        }
        expect(Atomics.load(gate, 1)).toBe(2);
        expect(Atomics.load(gate, 2)).toBe(2);
        expect(readdirSync(descriptorDirectory).length).toBe(descriptorsBefore);
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        hasher.close();
        port1.close();
        port2.close();
        await results;
      }
    },
  );

  it("falls back after construction fails with identical hashes and at most four in-process jobs", async ({
    signal,
  }) => {
    runtime.parallelism = 1;
    runtime.construct.mockImplementation(() => {
      throw new Error("fixture worker construction failed");
    });
    const { file, stat } = await fixture("fallback");
    const saturated = createDeferred();
    const release = createDeferred();
    let active = 0;
    let peak = 0;
    const fallback = vi.fn(async (pathname: string) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 4) {
        saturated.resolve();
      }
      try {
        await release.promise;
        return digest(await fs.readFile(pathname));
      } finally {
        active--;
      }
    });
    const hasher = createHasher(fallback);
    const hashes = Promise.all(Array.from({ length: 11 }, () => hasher.hash(file, stat)));
    hasher.flush();
    try {
      await withinTest(
        awaitGateBeforeSettlement(saturated.promise, hashes, "fallback did not admit four files"),
        signal,
      );
      expect(fallback).toHaveBeenCalledTimes(4);
      release.resolve();
      expect(await hashes).toEqual(Array.from({ length: 11 }, () => digest("package bytes")));
      const laterHash = hasher.hash(file, stat);
      hasher.flush();
      expect(await laterHash).toBe(digest("package bytes"));
      expect(peak).toBe(4);
      expect(fallback).toHaveBeenCalledTimes(12);
      expect(runtime.construct).toHaveBeenCalledOnce();
      expect(runtime.debug).toHaveBeenCalledExactlyOnceWith("package-file-hasher-fallback", {
        error: expect.any(Error),
      });
    } finally {
      release.resolve();
      await hashes;
    }
  });

  it("shares the four-file budget with healthy workers after a peer crashes", async ({
    signal,
  }) => {
    const { file, stat } = await fixture("mixed-fallback");
    const gate = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    const ready = Array.from({ length: 3 }, () => createDeferred());
    const channels: MessageChannel[] = [];
    runtime.construct.mockImplementation((source, options) => {
      const index = runtime.workers.length;
      if (index === 3) {
        return [
          `Atomics.wait(require("node:worker_threads").workerData.probeGate, 1, 0);
           throw new Error("fixture worker crashed");\n${String(source)}`,
          { ...options, workerData: { ...options.workerData, probeGate: gate } },
        ];
      }
      const channel = new MessageChannel();
      channels.push(channel);
      channel.port1.once("message", () => ready[index]!.resolve());
      return [
        `(() => {
          const fs = require("node:fs");
          const { probeGate, probePort } = require("node:worker_threads").workerData;
          const open = fs.openSync;
          const read = fs.readSync;
          const close = fs.closeSync;
          let stopped = false;
          fs.openSync = (...args) => {
            const fd = open(...args);
            Atomics.add(probeGate, 2, 1);
            return fd;
          };
          fs.readSync = (...args) => {
            if (!stopped) {
              stopped = true;
              probePort.postMessage("reading");
              probePort.close();
              Atomics.wait(probeGate, 0, 0);
            }
            return read(...args);
          };
          fs.closeSync = (...args) => {
            const result = close(...args);
            Atomics.sub(probeGate, 2, 1);
            return result;
          };
        })();\n${String(source)}`,
        {
          ...options,
          workerData: { ...options.workerData, probeGate: gate, probePort: channel.port2 },
          transferList: [channel.port2],
        },
      ];
    });
    const fallbackStarted = createDeferred();
    const releaseFallback = createDeferred();
    let peak = 0;
    const fallback = vi.fn(async (pathname: string) => {
      peak = Math.max(peak, Atomics.add(gate, 2, 1) + 1);
      fallbackStarted.resolve();
      try {
        await releaseFallback.promise;
        return digest(await fs.readFile(pathname));
      } finally {
        Atomics.sub(gate, 2, 1);
      }
    });
    const hasher = createHasher(fallback);
    const hashes = Promise.all(Array.from({ length: 64 }, () => hasher.hash(file, stat)));
    hasher.flush();
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all(ready.map(({ promise }) => promise)),
          hashes,
          "healthy workers never reached their file reads",
        ),
        signal,
      );
      expect(Atomics.load(gate, 2)).toBe(3);
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await withinTest(
        awaitGateBeforeSettlement(fallbackStarted.promise, hashes, "crashed job did not fall back"),
        signal,
      );
      expect(fallback).toHaveBeenCalledOnce();
      expect(Atomics.load(gate, 2)).toBe(4);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      releaseFallback.resolve();
      expect(await hashes).toEqual(Array.from({ length: 64 }, () => digest("package bytes")));
      const laterHash = hasher.hash(file, stat);
      hasher.flush();
      expect(await laterHash).toBe(digest("package bytes"));
      expect(peak).toBe(4);
      expect(Atomics.load(gate, 2)).toBe(0);
      // Cancellation also stops the healthy workers' active files; all 64 and the later hash rerun in-process.
      expect(fallback).toHaveBeenCalledTimes(65);
      expect(runtime.construct).toHaveBeenCalledTimes(4);
      expect(runtime.debug).toHaveBeenCalledExactlyOnceWith("package-file-hasher-fallback", {
        error: expect.any(Error),
      });
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      releaseFallback.resolve();
      await Promise.allSettled([hashes]);
      hasher.close();
      await Promise.all(runtime.exits);
      for (const { port1, port2 } of channels) {
        port1.close();
        port2.close();
      }
    }
  });
});
