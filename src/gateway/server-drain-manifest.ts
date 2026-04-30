import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChatRunRegistry } from "./server-chat-state.js";

const drainLog = createSubsystemLogger("gateway/drain-manifest");

export type DrainManifestEntry = {
  sessionId: string;
  sessionKey: string;
  clientRunId: string;
};

export type DrainManifest = {
  version: 1;
  writtenAt: string;
  sessions: DrainManifestEntry[];
};

const DRAIN_MANIFEST_FILENAME = "draining-sessions.json";

function resolveManifestPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, "state", DRAIN_MANIFEST_FILENAME);
}

/**
 * Write a drain manifest of all active chat runs to a durable file.
 * Called during gateway shutdown before sessions are cleared.
 */
export function writeDrainManifest(registry: ChatRunRegistry): void {
  const manifestPath = resolveManifestPath();
  const activeEntries = registry.entries();

  if (activeEntries.length === 0) {
    drainLog.info("no active sessions to drain, skipping manifest write");
    return;
  }

  const sessions: DrainManifestEntry[] = [];
  for (const entry of activeEntries) {
    for (const run of entry.runs) {
      sessions.push({
        sessionId: entry.sessionId,
        sessionKey: run.sessionKey,
        clientRunId: run.clientRunId,
      });
    }
  }

  const manifest: DrainManifest = {
    version: 1,
    writtenAt: new Date().toISOString(),
    sessions,
  };

  try {
    const dir = path.dirname(manifestPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    drainLog.info(
      `drain manifest written: ${sessions.length} active session(s) to ${manifestPath}`,
    );
  } catch (err) {
    drainLog.warn(`failed to write drain manifest: ${String(err)}`);
  }
}

/**
 * Delete the drain manifest after a clean shutdown.
 * If the manifest doesn't exist, this is a no-op.
 */
export function deleteDrainManifest(): void {
  const manifestPath = resolveManifestPath();
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
  const manifestPath = resolveManifestPath();
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
