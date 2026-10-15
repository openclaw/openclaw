import { Buffer } from "node:buffer";
import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import type { CronJob } from "./types.js";

export function resolveCronListSnapshotRevision(jobs: readonly CronJob[]): string {
  // Cover the full sorted result, not only one page, so clients can reject
  // offset pages produced before and after any mutation.
  return `sha256:${Buffer.from(sha256StableValue(jobs).digest, "hex").toString("base64url")}`;
}
