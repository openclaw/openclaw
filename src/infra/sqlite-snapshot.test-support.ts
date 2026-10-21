import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "@openclaw/fs-safe/durability";
import { expect, vi } from "vitest";

type Publisher = typeof import("@openclaw/fs-safe/durability").publishFileExclusive;
export type PublicationFixture = (
  options: Parameters<Publisher>[0],
  publish: Publisher,
) => ReturnType<Publisher>;

export function snapshotContent(bytes: Buffer) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

// Model the public copy receipt; native fallback selection belongs to fs-safe.
export function exclusiveCopyPublication(alterCopy?: (file: string) => Promise<void>) {
  return vi.fn<PublicationFixture>(async (options) => {
    expect(options.strategy).toBe("link-or-copy");
    await fs.copyFile(options.sourcePath, options.targetPath, fsSync.constants.COPYFILE_EXCL);
    await alterCopy?.(options.targetPath);
    await using target = await fs.open(options.targetPath, "r+");
    await target.sync();
    return {
      method: "exclusive-copy",
      identity: await target.stat(),
      exactIdentity: await target.stat({ bigint: true }),
      directorySync: await syncDirectory(path.dirname(options.targetPath)),
    };
  });
}
