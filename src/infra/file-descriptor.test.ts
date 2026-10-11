import { createHash } from "node:crypto";
import fsSync, { closeSync, openSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  copyFileHandle,
  hashFileDescriptorSync,
  hashFileMutationSnapshotSync,
} from "./file-descriptor.js";
import { createFileMutationClock } from "./file-mutation-clock.test-support.js";

let directory: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from("tail")]);
const expectedHash = createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  directory = tempDirs.make("openclaw-file-descriptor-");
});
afterEach(() => vi.restoreAllMocks());

describe("pinned file descriptors", () => {
  it.each([
    ["hard link", "native"],
    ["restored-mtime rewrite", "native"],
    ["hard link", "linux"],
    ["restored-mtime rewrite", "linux"],
    ["hard link", "android"],
    ["restored-mtime rewrite", "android"],
  ] as const)(
    "rechecks a %s between the digest and final path observation (%s birthtime)",
    async (change, birthtime) => {
      if (birthtime !== "native") {
        mockProcessPlatform(birthtime);
      }
      const file = path.join(directory, "snapshot");
      await fs.writeFile(file, Buffer.alloc(8192, 0x61));
      await fs.utimes(file, 1_700_000_000, 1_700_000_000);
      const read = fsSync.readSync;
      let hashed = false;
      vi.spyOn(fsSync, "readSync").mockImplementation((...args: Parameters<typeof read>) => {
        const count = read(...args);
        hashed ||= count === 0;
        return count;
      });
      let mutated = false;
      const advanceCtime = createFileMutationClock({
        birthtimeFromCtime: birthtime !== "native",
        beforeLstatSync: (pathname) => {
          if (pathname !== file || !hashed || mutated) {
            return;
          }
          mutated = true;
          if (change === "hard link") {
            fsSync.linkSync(file, path.join(directory, "capture"));
          } else {
            fsSync.writeFileSync(file, Buffer.alloc(8192, 0x62));
            fsSync.utimesSync(file, expected.atime, expected.mtime);
          }
          advanceCtime(expected);
        },
      });
      const expected = fsSync.lstatSync(file, { bigint: true });
      if (change === "hard link") {
        expect(hashFileMutationSnapshotSync(file, expected)).toBe(
          createHash("sha256").update(Buffer.alloc(8192, 0x61)).digest("hex"),
        );
      } else {
        expect(() => hashFileMutationSnapshotSync(file, expected)).toThrow(
          "changed while hashing snapshot",
        );
      }
      expect(mutated).toBe(true);
    },
  );

  it("hashes all bytes without moving or closing the borrowed descriptor", async () => {
    const sourcePath = path.join(directory, "source");
    await fs.writeFile(sourcePath, bytes);
    const fd = openSync(sourcePath, "r");
    try {
      readSync(fd, Buffer.alloc(2));
      expect(hashFileDescriptorSync(fd)).toEqual({
        sha256: expectedHash,
        sizeBytes: bytes.length,
      });
      const remaining = Buffer.alloc(bytes.length);
      const count = readSync(fd, remaining);
      expect(remaining.subarray(0, count)).toEqual(bytes.subarray(2));
    } finally {
      closeSync(fd);
    }
  });

  it("copies and observes all source bytes while retaining both handle positions", async () => {
    const source = await fs.open(path.join(directory, "source"), "wx+");
    const targetPath = path.join(directory, "target");
    const target = await fs.open(targetPath, "wx+");
    try {
      await source.writeFile(bytes);
      await target.writeFile("seed");
      const observed = createHash("sha256");
      expect(
        await copyFileHandle(source, target, {
          onChunk: (chunk) => {
            observed.update(chunk);
          },
        }),
      ).toBe(bytes.length);
      expect(observed.digest("hex")).toBe(expectedHash);
      expect(await fs.readFile(targetPath)).toEqual(bytes);
      expect(await source.readFile()).toHaveLength(0);
      expect(await target.readFile()).toEqual(bytes.subarray(4));
    } finally {
      await target.close();
      await source.close();
    }
  });
});
