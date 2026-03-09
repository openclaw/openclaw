import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const ACTIVE_TURNS_DIRNAME = "active-turns";

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
  void (async () => {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(marker, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.promises.rename(tmp, filePath);
  })().catch(() => {
    // Best-effort — never block the hot path.
  });
}

/**
 * Remove an active turn marker from disk. Fire-and-forget — never throws.
 */
export function clearActiveTurn(sessionId: string, env?: NodeJS.ProcessEnv): void {
  if (sessionId.startsWith("probe-")) {
    return;
  }
  const filePath = resolveMarkerPath(sessionId, env);
  void fs.promises.unlink(filePath).catch(() => {
    // Best-effort — silently ignore ENOENT or other errors.
  });
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
      if (parsed && typeof parsed.sessionId === "string" && typeof parsed.sessionKey === "string") {
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
