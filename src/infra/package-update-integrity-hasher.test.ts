import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { MessageChannel, type Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function waitForGate(
  gate: PromiseLike<unknown>,
  work: PromiseLike<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
}

function releaseGate(gate: Int32Array, index = 0) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}

function flushHashes(
  hasher: PackageFileHasher,
  input: Awaited<ReturnType<typeof fixture>>,
  count = 1,
) {
  const hashes = Promise.all(
    Array.from({ length: count }, () => hasher.hash(input.file, input.stat)),
  );
  hasher.flush();
  return hashes;
}

// The same real-worker probe counts completed descriptors for cancellation and
// active descriptors for fallback. Only the selected file pauses in cancellation.
function probeWorker(
  source: string | URL,
  options: WorkerOptions,
  gate: Int32Array,
  port: MessageChannel["port2"],
  file?: string,
): [string, WorkerOptions] {
  return [
    `(() => {
          const fs = require("node:fs");
          const { probeGate, probePort, probeFile } = require("node:worker_threads").workerData;
          const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fstat = fs.fstatSync;
          let stopped = false, targetFd;
          fs.openSync = (...args) => {
            const fd = open(...args);
            Atomics.add(probeGate, probeFile ? 1 : 2, 1);
            if (args[0] === probeFile) targetFd = fd;
            return fd;
          };
          fs.readSync = (...args) => {
            if ((!probeFile || args[0] === targetFd) && !stopped) {
              stopped = true;
              probePort.postMessage("reading");
              probePort.close();
              Atomics.wait(probeGate, 0, 0);
            }
            return read(...args);
          };
          fs.fstatSync = (...args) => {
            if (probeFile && args[0] === targetFd) Atomics.add(probeGate, 3, 1);
            return fstat(...args);
          };
          fs.closeSync = (...args) => {
            const result = close(...args);
            Atomics.add(probeGate, 2, probeFile ? 1 : -1);
            return result;
          };
        })();\n${String(source)}`,
    {
      ...options,
      workerData: { ...options.workerData, probeGate: gate, probePort: port, probeFile: file },
      transferList: [port],
    },
  ];
}

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
    runtime.construct.mockImplementation((source, options) =>
      probeWorker(source, options, gate, port2, inputs[1]!.file),
    );
    const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const descriptorsBefore = readdirSync(descriptorDirectory).length;
    const hasher = createHasher();
    const results = Promise.allSettled(inputs.map(({ file, stat }) => hasher.hash(file, stat)));
    hasher.flush();
    try {
      await waitForGate(reading.promise, results, signal, "worker never reached its file read");
      hasher.close();
      expect([Atomics.load(gate, 1), Atomics.load(gate, 2)]).toEqual([2, 1]);
      releaseGate(gate);
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
      expect([Atomics.load(gate, 1), Atomics.load(gate, 2)]).toEqual([2, 2]);
      expect(readdirSync(descriptorDirectory).length).toBe(descriptorsBefore);
    } finally {
      releaseGate(gate);
      hasher.close();
      port1.close();
      port2.close();
      await results;
    }
  },
);

it.each(["construction", "crash"] as const)(
  "shares the four-file budget and preserves hashes after worker %s failure",
  async (failure, { signal }) => {
    const crashing = failure === "crash";
    const count = crashing ? 64 : 11;
    const input = await fixture("fallback");
    const gate = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    const ready = Array.from({ length: 3 }, () => createDeferred());
    const channels: MessageChannel[] = [];
    runtime.parallelism = crashing ? 4 : 1;
    runtime.construct.mockImplementation((source, options) => {
      if (!crashing) {
        throw new Error("fixture worker construction failed");
      }
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
      return probeWorker(source, options, gate, channel.port2);
    });
    const saturated = createDeferred();
    const release = createDeferred();
    let peak = 0;
    const fallback = vi.fn(async (pathname: string) => {
      const active = Atomics.add(gate, 2, 1) + 1;
      peak = Math.max(peak, active);
      if (crashing || active === 4) {
        saturated.resolve();
      }
      try {
        await release.promise;
        return digest(await fs.readFile(pathname));
      } finally {
        Atomics.sub(gate, 2, 1);
      }
    });
    const hasher = createHasher(fallback);
    const hashes = flushHashes(hasher, input, count);
    try {
      if (crashing) {
        await waitForGate(
          Promise.all(ready.map(({ promise }) => promise)),
          hashes,
          signal,
          "healthy workers never reached file reads",
        );
        expect(Atomics.load(gate, 2)).toBe(3);
        releaseGate(gate, 1);
      }
      await waitForGate(
        saturated.promise,
        hashes,
        signal,
        "fallback did not fill the four-file budget",
      );
      expect(fallback).toHaveBeenCalledTimes(crashing ? 1 : 4);
      if (crashing) {
        expect(Atomics.load(gate, 2)).toBe(4);
      }
      releaseGate(gate);
      release.resolve();
      expect(await hashes).toEqual(Array.from({ length: count }, () => digest("package bytes")));
      expect(await flushHashes(hasher, input)).toEqual([digest("package bytes")]);
      expect(peak).toBe(4);
      if (crashing) {
        expect(Atomics.load(gate, 2)).toBe(0);
      }
      expect(fallback).toHaveBeenCalledTimes(count + 1);
      expect(runtime.construct).toHaveBeenCalledTimes(crashing ? 4 : 1);
      expect(runtime.debug).toHaveBeenCalledExactlyOnceWith("package-file-hasher-fallback", {
        error: expect.any(Error),
      });
    } finally {
      releaseGate(gate);
      releaseGate(gate, 1);
      release.resolve();
      await Promise.allSettled([hashes]);
      hasher.close();
      await Promise.all(runtime.exits);
      for (const { port1, port2 } of channels) {
        port1.close();
        port2.close();
      }
    }
  },
);
