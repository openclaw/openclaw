import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChatRunRegistry } from "./server-chat-state.js";

const drainLog = createSubsystemLogger("gateway/drain-manifest");

export type DrainManifestEntry = {
  runId: string;
  sessionKey: string;
  clientRunId: string;
};

export type DrainManifest = {
  version: 1;
  writtenAt: string;
  sessions: DrainManifestEntry[];
};

const DRAIN_MANIFEST_FILENAME = "draining-sessions.json";

export function resolveDrainManifestPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, "state", DRAIN_MANIFEST_FILENAME);
}

/**
 * Write a drain manifest of all active chat runs to a durable file.
 * Called during gateway shutdown before sessions are cleared.
 *
 * Returns the number of active sessions captured. Write failures are allowed
 * to propagate so shutdown warning accounting can record the failure.
 */
export function writeDrainManifest(registry: Pick<ChatRunRegistry, "entries">): number {
  const manifestPath = resolveDrainManifestPath();
  const activeEntries = registry.entries();

  const sessions: DrainManifestEntry[] = [];
  for (const entry of activeEntries) {
    for (const run of entry.runs) {
      sessions.push({
        runId: entry.runId,
        sessionKey: run.sessionKey,
        clientRunId: run.clientRunId,
      });
    }
  }

  if (sessions.length === 0) {
    drainLog.info("no active sessions to drain, skipping manifest write");
    return 0;
  }

  const manifest: DrainManifest = {
    version: 1,
    writtenAt: new Date().toISOString(),
    sessions,
  };

  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(manifestPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmpPath, manifestPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  drainLog.info(`drain manifest written: ${sessions.length} active session(s) to ${manifestPath}`);
  return sessions.length;
}

/**
 * Delete the drain manifest after a clean shutdown.
 * If the manifest doesn't exist, this is a no-op.
 */
export function deleteDrainManifest(): void {
  const manifestPath = resolveDrainManifestPath();
  try {
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      drainLog.info("drain manifest deleted (clean shutdown)");
    }
  } catch (err) {
    drainLog.warn(`failed to delete drain manifest: ${String(err)}`);
  }
}

/**
 * Read and parse the drain manifest from disk.
 * Returns null if no manifest exists or it's invalid.
 */
export function readDrainManifest(): DrainManifest | null {
  const manifestPath = resolveDrainManifestPath();
  try {
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed?.sessions)) {
      drainLog.warn(`drain manifest has invalid format, ignoring`);
      return null;
    }
    return parsed as DrainManifest;
  } catch (err) {
    drainLog.warn(`failed to read drain manifest: ${String(err)}`);
    return null;
  }
}
