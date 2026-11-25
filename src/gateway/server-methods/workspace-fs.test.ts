import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { readWorkspaceFilePrefix, updateWorkspaceFile } from "./workspace-fs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(vi.restoreAllMocks);

it("preserves the workspace file when editor authority expires during write preparation", async () => {
  const tempDir = tempDirs.make("openclaw-workspace-fs-authority-");
  const filePath = path.join(tempDir, "notes.txt");
  const original = "authored notes";
  await writeFile(filePath, original);
  const revoked = new Error("workspace editor authority expired");
  let authorized = true;
  const createRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...rootArgs) => {
    const opened = await createRoot(...rootArgs);
    const write = opened.write.bind(opened);
    opened.write = async (...writeArgs) => {
      await Promise.resolve();
      authorized = false;
      return await write(...writeArgs);
    };
    return opened;
  });

  await expect(
    updateWorkspaceFile(
      tempDir,
      "notes.txt",
      "unapproved replacement",
      createHash("sha256").update(original).digest("hex"),
      () => {
        if (!authorized) {
          throw revoked;
        }
      },
    ),
  ).rejects.toBe(revoked);
  expect(authorized).toBe(false);
  expect(await readFile(filePath, "utf8")).toBe(original);
});

type FileHandleRead = (
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

it.each([
  ["short reads", "prefix-bytes-that-must-not-be-truncated", 100, 1, undefined],
  ["explicit EOF", "pre", 100, 3, 2],
  ["maxBytes", "bounded", 7, undefined, undefined],
] as const)(
  "readWorkspaceFilePrefix handles %s",
  async (mode, expected, maxBytes, chunkSize, eofRead) => {
    const content =
      mode === "explicit EOF" ? "prefix" : mode === "maxBytes" ? "bounded-prefix" : expected;
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-");
    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, content);
    let readCount = 0;
    if (chunkSize !== undefined) {
      const probe = await open(filePath, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandleRead };
      await probe.close();
      const originalRead = fileHandlePrototype.read;
      vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
        this: unknown,
        target,
        offset,
        length,
        position,
      ) {
        if (++readCount === eofRead) {
          return { bytesRead: 0, buffer: target };
        }
        return await originalRead.call(this, target, offset, Math.min(length, chunkSize), position);
      });
    }
    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", maxBytes);
    assert(result && result !== "unsupported");
    expect(result.buffer).toEqual(Buffer.from(expected));
    expect(result).toMatchObject({ canonicalPath: "notes.txt", stat: { size: content.length } });
    if (eofRead) {
      expect(readCount).toBe(eofRead);
    }
  },
);
