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
const DRAIN_MANIFEST_MAX_BYTES = 1024 * 1024;

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateDrainManifestEntry(entry: unknown): entry is DrainManifestEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const candidate = entry as Partial<Record<keyof DrainManifestEntry, unknown>>;
  return (
    isNonEmptyString(candidate.runId) &&
    isNonEmptyString(candidate.sessionKey) &&
    isNonEmptyString(candidate.clientRunId)
  );
}

function validateDrainManifest(parsed: unknown): DrainManifest | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as Partial<Record<keyof DrainManifest, unknown>>;
  if (
    candidate.version !== 1 ||
    !isNonEmptyString(candidate.writtenAt) ||
    Number.isNaN(Date.parse(candidate.writtenAt)) ||
    !Array.isArray(candidate.sessions)
  ) {
    return null;
  }
  if (!candidate.sessions.every((entry) => validateDrainManifestEntry(entry))) {
    return null;
  }
  return {
    version: 1,
    writtenAt: candidate.writtenAt,
    sessions: candidate.sessions,
  };
}

/**
 * Read and parse the drain manifest from disk.
 * Returns null if no manifest exists or it's invalid.
 */
export function readDrainManifest(): DrainManifest | null {
  const manifestPath = resolveDrainManifestPath();
  let raw: string;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.nlink > 1) {
      drainLog.warn(`drain manifest is not a regular single-link file, ignoring`);
      return null;
    }
    if (stat.size > DRAIN_MANIFEST_MAX_BYTES) {
      drainLog.warn(`drain manifest exceeds ${DRAIN_MANIFEST_MAX_BYTES} bytes, ignoring`);
      return null;
    }
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      drainLog.warn(`failed to read drain manifest: ${String(err)}`);
    }
    return null;
  }

  try {
    const manifest = validateDrainManifest(JSON.parse(raw));
    if (!manifest) {
      drainLog.warn(`drain manifest has invalid format, ignoring`);
      return null;
    }
    return manifest;
  } catch (err) {
    drainLog.warn(`failed to parse drain manifest: ${String(err)}`);
    return null;
  }
}
