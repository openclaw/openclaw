import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  MessageChannel,
  type MessagePort,
  type Worker,
  type WorkerOptions,
} from "node:worker_threads";
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
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => runtime.parallelism,
}));
// mock-isolation: Worker hashing tests do not initialize the process-wide logging subsystem.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug() {} }),
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
    vi.unstubAllGlobals();
    cleanup();
  }),
);

beforeEach(() => {
  runtime.parallelism = 4;
  runtime.workers.length = 0;
  runtime.exits.length = 0;
  runtime.construct.mockReset().mockImplementation((source, options) => [source, options]);
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

// Both race tests pause a real file read, and count only package-file descriptors.
function probeReads(
  source: string | URL,
  options: WorkerOptions,
  gate: Int32Array,
  port: MessagePort,
  files: string[],
  pausedFile = files[0],
): [string, WorkerOptions] {
  return [
    `(() => {
      const fs = require("node:fs");
      const { gate, port, files, pausedFile } = require("node:worker_threads").workerData.probe;
      const { openSync, readSync, closeSync, fstatSync } = fs;
      const packageFiles = new Set(files), packageFds = new Set();
      let stopped = false, targetFd;
      fs.openSync = (...args) => {
        const fd = openSync(...args);
        if (packageFiles.has(args[0])) {
          packageFds.add(fd);
          Atomics.add(gate, 1, 1);
        }
        if (args[0] === pausedFile) targetFd = fd;
        return fd;
      };
      fs.readSync = (...args) => {
        if (args[0] === targetFd && !stopped) {
          stopped = true;
          port.postMessage("reading");
          port.close();
          Atomics.wait(gate, 0, 0);
        }
        return readSync(...args);
      };
      fs.fstatSync = (...args) => {
        if (args[0] === targetFd) Atomics.add(gate, 3, 1);
        return fstatSync(...args);
      };
      fs.closeSync = (...args) => {
        const result = closeSync(...args);
        if (packageFds.delete(args[0])) Atomics.add(gate, 2, 1);
        return result;
      };
    })();\nimport(${JSON.stringify(String(source))});`,
    {
      ...options,
      eval: true,
      workerData: { ...options.workerData, probe: { gate, port, files, pausedFile } },
      transferList: [port],
    },
  ];
}

function releaseGate(gate: Int32Array, index = 0) {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
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

  it("keeps sealed recovery hashing inside its self-contained helper", async () => {
    vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    const { file, stat } = await fixture("sealed");
    const fallback = vi.fn(async (pathname: string) => digest(await fs.readFile(pathname)));
    const hasher = createHasher(fallback);
    const result = hasher.hash(file, stat);
    hasher.flush();
    await expect(result).resolves.toBe(digest("package bytes"));
    expect(fallback).toHaveBeenCalledOnce();
    expect(runtime.construct).not.toHaveBeenCalled();
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
        probeReads(
          source,
          options,
          gate,
          port2,
          inputs.map(({ file }) => file),
          inputs[1]!.file,
        ),
      );
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
        expect(Atomics.load(gate, 1)).toBe(2);
        expect(Atomics.load(gate, 2)).toBe(2);
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

  it.for([
    { failure: "construction", healthy: 0, jobs: 11 },
    { failure: "peer crash", healthy: 3, jobs: 64 },
  ])(
    "preserves hashes and the shared four-file budget after $failure",
    async ({ healthy, jobs }, { signal }) => {
      runtime.parallelism = healthy + 1;
      const { file, stat } = await fixture("fallback");
      const gate = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
      const activeFiles = () => Atomics.load(gate, 1) - Atomics.load(gate, 2);
      const ready = Array.from({ length: healthy }, () => createDeferred());
      const channels: MessageChannel[] = [];
      runtime.construct.mockImplementation((source, options) => {
        if (!healthy) {
          throw new Error("fixture worker construction failed");
        }
        const index = runtime.workers.length;
        if (index === healthy) {
          return [
            `Atomics.wait(require("node:worker_threads").workerData.probeGate, 4, 0);
           throw new Error("fixture worker crashed");\nimport(${JSON.stringify(String(source))});`,
            { ...options, eval: true, workerData: { ...options.workerData, probeGate: gate } },
          ];
        }
        const channel = new MessageChannel();
        channels.push(channel);
        channel.port1.once("message", () => ready[index]!.resolve());
        return probeReads(source, options, gate, channel.port2, [file]);
      });
      const saturated = createDeferred();
      const releaseFallback = createDeferred();
      let peak = 0;
      const fallback = vi.fn(async (pathname: string) => {
        Atomics.add(gate, 1, 1);
        peak = Math.max(peak, activeFiles());
        if (activeFiles() === 4) {
          saturated.resolve();
        }
        try {
          await releaseFallback.promise;
          return digest(await fs.readFile(pathname));
        } finally {
          Atomics.add(gate, 2, 1);
        }
      });
      const hasher = createHasher(fallback);
      const hashes = Promise.all(Array.from({ length: jobs }, () => hasher.hash(file, stat)));
      hasher.flush();
      try {
        if (healthy) {
          await withinTest(
            awaitGateBeforeSettlement(
              Promise.all(ready.map(({ promise }) => promise)),
              hashes,
              "healthy workers never reached their file reads",
            ),
            signal,
          );
          expect(activeFiles()).toBe(healthy);
          releaseGate(gate, 4);
        }
        await withinTest(
          awaitGateBeforeSettlement(
            saturated.promise,
            hashes,
            "fallback did not fill the file budget",
          ),
          signal,
        );
        expect(fallback).toHaveBeenCalledTimes(4 - healthy);
        expect(activeFiles()).toBe(4);
        releaseGate(gate);
        releaseFallback.resolve();
        expect(await hashes).toEqual(Array.from({ length: jobs }, () => digest("package bytes")));
        const laterHash = hasher.hash(file, stat);
        hasher.flush();
        expect(await laterHash).toBe(digest("package bytes"));
        expect(peak).toBe(4);
        expect(activeFiles()).toBe(0);
        // A peer failure cancels healthy workers too; every job reruns in-process.
        expect(fallback).toHaveBeenCalledTimes(jobs + 1);
        expect(runtime.construct).toHaveBeenCalledTimes(healthy + 1);
      } finally {
        releaseGate(gate);
        releaseGate(gate, 4);
        releaseFallback.resolve();
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
});
