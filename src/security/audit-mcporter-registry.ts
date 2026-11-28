// Bounded read of the global MCP registry for security audit.
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, readLocalFileSafely } from "../infra/fs-safe.js";

const MAX_MCPORTER_REGISTRY_BYTES = 16 * 1024 * 1024;

export type McporterRegistryRejectReason = "oversized" | "unreadable" | "non-regular" | "malformed";

// Missing means no registry exists (non-actionable); rejected means a registry
// exists but could not be safely inspected, so the audit must warn instead of
// silently dropping the MCP boundary input.
export type McporterRegistryReadOutcome =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "rejected"; reason: McporterRegistryRejectReason };

export async function readBoundedMcporterRegistry(
  stateDir: string,
): Promise<McporterRegistryReadOutcome> {
  const registryPath = path.join(stateDir, "skills", "config", "mcporter.json");
  try {
    // Configured registry links may point outside the state directory.
    const { buffer } = await readLocalFileSafely({
      filePath: await fs.realpath(registryPath),
      maxBytes: MAX_MCPORTER_REGISTRY_BYTES,
    });
    try {
      const value: unknown = JSON.parse(buffer.toString("utf-8"));
      return { status: "ok", value };
    } catch {
      return { status: "rejected", reason: "malformed" };
    }
  } catch (error) {
    const code = error instanceof FsSafeError ? error.code : undefined;
    if (hasErrnoCode(error, "ENOENT") || code === "not-found") {
      return { status: "missing" };
    }
    return {
      status: "rejected",
      reason:
        code === "too-large" ? "oversized" : code === "not-file" ? "non-regular" : "unreadable",
    };
  }
}
