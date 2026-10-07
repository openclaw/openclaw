import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { isNoReplaceUnsupported } from "@openclaw/fs-safe/errors";
import {
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";

/** Publish a private capture without requiring native no-replace rename support. */
export async function publishUpdateRecoveryCaptureFile(
  params: Omit<Parameters<typeof publishFileExclusive>[0], "strategy"> & {
    expectedSourceIdentity: BigIntStats;
    assertCurrent: () => void;
  },
) {
  params.assertCurrent();
  try {
    return await publishFileExclusive({ ...params, strategy: "rename-noreplace" });
  } catch (error) {
    // Only unsupported, pre-publication failures permit a second publication attempt.
    if (!isNoReplaceUnsupported(error) || getFsSafeNativeConfig().mode === "require") {
      throw error;
    }
  }
  params.assertCurrent();
  const published = await publishFileExclusive({ ...params, strategy: "link-or-copy" });
  const current = await fs.lstat(params.sourcePath, { bigint: true });
  params.assertCurrent();
  if (!current.isFile() || !sameFileIdentity(params.expectedSourceIdentity, current)) {
    throw new Error(`Original capture source changed before removal: ${params.sourcePath}`);
  }
  // The publisher has closed its handles; unlinking now also avoids FUSE hidden files.
  await fs.unlink(params.sourcePath);
  requireDirectorySync(
    await syncDirectory(path.dirname(params.sourcePath)),
    "Original capture source removal",
  );
  return published;
}
