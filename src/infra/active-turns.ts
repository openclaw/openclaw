import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const ACTIVE_TURNS_DIRNAME = "active-turns";

/**
 * Track pending write promises per session so that clearActiveTurn can wait
 * for the write to finish before unlinking, preventing the race where unlink
 * fires before rename completes and leaves a stale marker on disk.
 */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Monotonically increasing write generation per session. Each writeActiveTurn
 * call bumps the generation so that a stale clearActiveTurn (from a previous
 * turn) can detect that a newer write happened and skip the unlink.
 */
const writeGenerations = new Map<string, number>();

/** Monotonic counter for unique temp file names within a single process. */
let tmpCounter = 0;

export type ActiveTurnMarker = {
  sessionId: string;
  sessionKey: string;
  startedAt: number;
};

function resolveActiveTurnsDir(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), ACTIVE_TURNS_DIRNAME);
}

function resolveMarkerPath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  // Sanitize sessionId to prevent path traversal.
  const safe = sessionId.replaceAll(/[/\\:]/g, "_");
  return path.join(resolveActiveTurnsDir(env), `${safe}.json`);
}

/**
 * Persist an active turn marker to disk. Fire-and-forget — never throws.
 * Skipped for probe sessions (health checks).
 */
export function writeActiveTurn(
  sessionId: string,
  sessionKey: string,
  env?: NodeJS.ProcessEnv,
): void {
  if (sessionId.startsWith("probe-")) {
    return;
  }
  const marker: ActiveTurnMarker = { sessionId, sessionKey, startedAt: Date.now() };
  const filePath = resolveMarkerPath(sessionId, env);
  // Bump write generation so stale clears from a previous turn can detect
  // that a newer write happened and skip the unlink.
  const gen = (writeGenerations.get(sessionId) ?? 0) + 1;
  writeGenerations.set(sessionId, gen);
  const writePromise = (async () => {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Use a unique temp path per write to avoid races when two rapid writes
    // for the same session share the same tmp file.
    const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(marker, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.promises.rename(tmp, filePath);
  })().catch(() => {
    // Best-effort — never block the hot path.
  });
  pendingWrites.set(sessionId, writePromise);
  void writePromise.finally(() => {
    // Only clean up if this is still the latest write for this session.
    if (pendingWrites.get(sessionId) === writePromise) {
      pendingWrites.delete(sessionId);
    }
  });
}

/**
 * Remove an active turn marker from disk. Fire-and-forget — never throws.
 * Waits for any pending write to finish first so the unlink doesn't race
 * ahead of the atomic rename.
 */
export function clearActiveTurn(sessionId: string, env?: NodeJS.ProcessEnv): void {
  if (sessionId.startsWith("probe-")) {
    return;
  }
  const filePath = resolveMarkerPath(sessionId, env);
  const pending = pendingWrites.get(sessionId);
  // Capture the current write generation. If a newer writeActiveTurn fires
  // between now and when the unlink runs, the generation will have changed
  // and we must skip the unlink to avoid deleting the newer marker.
  const genAtClear = writeGenerations.get(sessionId) ?? 0;
  const doUnlink = () => {
    const currentGen = writeGenerations.get(sessionId) ?? 0;
    if (currentGen !== genAtClear) {
      // A newer write started after this clear was issued — do not delete
      // the marker that belongs to the new run.
      return Promise.resolve();
    }
    return fs.promises.unlink(filePath).catch(() => {});
  };
  if (pending) {
    void pending.then(doUnlink);
  } else {
    void doUnlink();
  }
}

/**
 * Load all active turn markers from disk.
 * Used at startup to detect interrupted turns and by the stuck turn watchdog.
 */
export async function loadActiveTurnMarkers(env?: NodeJS.ProcessEnv): Promise<ActiveTurnMarker[]> {
  const dir = resolveActiveTurnsDir(env);
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const markers: ActiveTurnMarker[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, file);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ActiveTurnMarker;
      if (
        parsed &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.sessionKey === "string" &&
        typeof parsed.startedAt === "number" &&
        Number.isFinite(parsed.startedAt)
      ) {
        markers.push(parsed);
      }
    } catch {
      // Skip corrupt or inaccessible files.
    }
  }
  return markers;
}

/**
 * Remove a specific marker by sessionId (synchronous path resolution, async delete).
 * Unlike clearActiveTurn, this returns a promise for use in recovery flows.
 */
export async function removeActiveTurnMarker(
  sessionId: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const filePath = resolveMarkerPath(sessionId, env);
  await fs.promises.unlink(filePath).catch(() => {});
}

export { resolveActiveTurnsDir as __testing_resolveActiveTurnsDir };
