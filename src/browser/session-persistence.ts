import fs from "node:fs";
import path from "node:path";
import { withCdpSocket } from "./cdp.helpers.js";

const STATE_FILENAME = "openclaw-saved-state.json";

/** Default interval between periodic cookie saves (ms). */
export const DEFAULT_SESSION_PERSISTENCE_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SavedBrowserState {
  version: 1;
  savedAt: string; // ISO timestamp
  cookies: CdpCookie[];
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
}

// ---------------------------------------------------------------------------
// Save / Restore
// ---------------------------------------------------------------------------

/**
 * Save all cookies from the browser via CDP `Network.getAllCookies`.
 * Writes atomically (tmp + rename) to prevent corruption on crash.
 */
export async function saveBrowserState(
  cdpWsUrl: string,
  userDataDir: string,
): Promise<{ cookieCount: number }> {
  const cookies = await getAllCookiesViaCdp(cdpWsUrl);

  const state: SavedBrowserState = {
    version: 1,
    savedAt: new Date().toISOString(),
    cookies,
  };

  const statePath = path.join(userDataDir, STATE_FILENAME);
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, statePath);

  return { cookieCount: cookies.length };
}

/**
 * Restore cookies from a previously saved state file into the browser
 * via CDP `Network.setCookies`.
 *
 * Returns `null` when there is nothing to restore (missing / empty / corrupt file).
 */
export async function restoreBrowserState(
  cdpWsUrl: string,
  userDataDir: string,
): Promise<{ cookieCount: number; savedAt: string } | null> {
  const statePath = path.join(userDataDir, STATE_FILENAME);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  let state: SavedBrowserState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SavedBrowserState;
  } catch {
    return null; // corrupted file — skip silently
  }

  if (state.version !== 1 || !Array.isArray(state.cookies)) {
    return null;
  }
  if (state.cookies.length === 0) {
    return null;
  }

  // Filter out expired cookies (keep session cookies and those with no/negative expiry)
  const now = Date.now() / 1000;
  const validCookies = state.cookies.filter(
    (c) => c.session || c.expires === -1 || c.expires === 0 || c.expires > now,
  );

  if (validCookies.length === 0) {
    return null; // all cookies expired — nothing useful to restore
  }

  await setCookiesViaCdp(cdpWsUrl, validCookies);

  return { cookieCount: validCookies.length, savedAt: state.savedAt };
}

// ---------------------------------------------------------------------------
// Periodic save
// ---------------------------------------------------------------------------

export type SessionPersistenceLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

/**
 * Start a periodic cookie save timer. Returns a cleanup function that
 * stops the timer when called.
 */
export function startPeriodicSave(
  getCdpWsUrl: () => Promise<string | null>,
  userDataDir: string,
  log: SessionPersistenceLog,
  intervalMs = DEFAULT_SESSION_PERSISTENCE_INTERVAL_MS,
): () => void {
  let saving = false;
  const timer = setInterval(async () => {
    if (saving) {
      return;
    }
    saving = true;
    try {
      const wsUrl = await getCdpWsUrl();
      if (!wsUrl) {
        return;
      } // browser not running
      const result = await saveBrowserState(wsUrl, userDataDir);
      if (result.cookieCount > 0) {
        log.info(`🍪 saved ${result.cookieCount} cookies`);
      }
    } catch (err) {
      log.warn(`cookie periodic save failed: ${String(err)}`);
    } finally {
      saving = false;
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// CDP helpers (private)
// ---------------------------------------------------------------------------

async function getAllCookiesViaCdp(cdpWsUrl: string): Promise<CdpCookie[]> {
  return await withCdpSocket(cdpWsUrl, async (send) => {
    const result = (await send("Network.getAllCookies", {})) as { cookies?: CdpCookie[] };
    return result.cookies ?? [];
  });
}

async function setCookiesViaCdp(cdpWsUrl: string, cookies: CdpCookie[]): Promise<void> {
  await withCdpSocket(cdpWsUrl, async (send) => {
    // setCookies expects a slightly different shape — omit runtime-only fields
    const setCookieParams = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      expires: c.session ? undefined : c.expires,
    }));

    await send("Network.setCookies", { cookies: setCookieParams });
  });
}

// ---------------------------------------------------------------------------
// Utility (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve the state file path for a given user data directory. */
export function getStateFilePath(userDataDir: string): string {
  return path.join(userDataDir, STATE_FILENAME);
}
