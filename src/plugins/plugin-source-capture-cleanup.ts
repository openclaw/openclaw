import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";

export type TokenlessCaptureSweep = { unknownReason?: string };

/** Missing custody is reclaimable only with complete, current active-use evidence. */
export async function reclaimTokenlessPluginSourceCapture(
  directory: string,
  original: Stats,
  legacy: boolean,
  sweep: TokenlessCaptureSweep,
): Promise<void> {
  if (sweep.unknownReason) {
    return;
  }
  const { inspectTemporaryDirectoryUsage } = await import("../infra/temp-directory-usage.js");
  const usage = inspectTemporaryDirectoryUsage(directory);
  if (usage.kind !== "inactive") {
    if (usage.kind === "unknown") {
      sweep.unknownReason = usage.reason;
    }
    return;
  }
  const current = await fs.lstat(directory);
  if (
    current.dev !== original.dev ||
    current.ino !== original.ino ||
    !current.isDirectory() ||
    (process.getuid && current.uid !== process.getuid())
  ) {
    return;
  }
  // Keep interrupted removals recognizable to the next sweep.
  const retired = path.join(
    path.dirname(directory),
    `${legacy ? PLUGIN_SOURCE_CAPTURE_PREFIX : ""}${randomUUID()}`,
  );
  await fs.rename(directory, retired);
  await fs.rm(retired, { recursive: true, force: true });
}
