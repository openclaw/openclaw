import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { readWorkspaceFilePrefix, updateWorkspaceFile } from "./workspace-fs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

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

  const error = await updateWorkspaceFile(
    tempDir,
    "notes.txt",
    "unapproved replacement",
    createHash("sha256").update(original).digest("hex"),
    () => {
      if (!authorized) {
        throw revoked;
      }
    },
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(authorized).toBe(false);
  expect(error).toBe(revoked);
  expect(await readFile(filePath, "utf8")).toBe(original);
});

type FileHandleRead = (
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

async function getFileHandleRead(filePath: string) {
  const probe = await open(filePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandleRead };
  await probe.close();
  return fileHandlePrototype;
}

describe("readWorkspaceFilePrefix", () => {
  it("fills the bounded prefix when the handle serves short reads", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-");
    const filePath = path.join(tempDir, "notes.txt");
    const content = Buffer.from("prefix-bytes-that-must-not-be-truncated");
    await writeFile(filePath, content);

    const fileHandlePrototype = await getFileHandleRead(filePath);
    const originalRead = fileHandlePrototype.read;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: unknown,
      target,
      offset,
      length,
      position,
    ) {
      return await originalRead.call(this, target, offset, Math.min(length, 1), position);
    });

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 100);

    expect(result?.buffer).toEqual(content);
    expect(result?.canonicalPath).toBe("notes.txt");
    expect(result?.stat.size).toBe(content.length);
  });

  it("returns bytes read before an explicit EOF", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-eof-");
    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "prefix");

    const fileHandlePrototype = await getFileHandleRead(filePath);
    const originalRead = fileHandlePrototype.read;
    let readCount = 0;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: unknown,
      target,
      offset,
      length,
      position,
    ) {
      readCount += 1;
      if (readCount === 2) {
        return { bytesRead: 0, buffer: target };
      }
      return await originalRead.call(this, target, offset, Math.min(length, 3), position);
    });

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 100);

    expect(result?.buffer.toString()).toBe("pre");
    expect(readCount).toBe(2);
  });

  it("still bounds the returned prefix to maxBytes", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-bound-");
    await writeFile(path.join(tempDir, "notes.txt"), "bounded-prefix");

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 7);

    expect(result?.buffer.toString()).toBe("bounded");
  });
});
