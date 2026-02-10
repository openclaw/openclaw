import type { BrowserContext } from "playwright-core";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import { firefox } from "playwright-core";
import type { RunningBrowser } from "./browser-process.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import { resolveFirefoxExecutableForPlatform } from "./firefox.executables.js";

const log = createSubsystemLogger("browser").child("firefox");

/**
 * Map of profile name -> Playwright BrowserContext for Firefox.
 * Firefox doesn't expose CDP, so we keep the context alive for the session lifetime.
 */
const firefoxContexts = new Map<string, BrowserContext>();

export function getFirefoxContext(profileName: string): BrowserContext | undefined {
  return firefoxContexts.get(profileName);
}

/**
 * Launch Firefox via Playwright's persistent context.
 * Returns a RunningBrowser handle compatible with the Chromium path.
 */
export async function launchOpenClawFirefox(
  profile: ResolvedBrowserProfile,
  opts: { headless?: boolean } = {},
): Promise<RunningBrowser> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Firefox.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveFirefoxExecutableForPlatform(process.platform);
  if (!exe) {
    throw new Error(
      "No Firefox installation found. Install Firefox or run `npx playwright install firefox`.",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const startedAt = Date.now();

  // Playwright's launchPersistentContext manages Firefox via Marionette internally.
  const context = await firefox.launchPersistentContext(userDataDir, {
    headless: opts.headless ?? false,
    executablePath: exe.path,
    args: ["--no-remote"],
    // Open with a blank page so there's always a target
    viewport: null,
  });

  firefoxContexts.set(profile.name, context);

  // Ensure at least one page exists
  if (context.pages().length === 0) {
    await context.newPage();
  }

  const pid = extractPidFromContext(context);

  log.info(`openclaw firefox started (${exe.kind}) profile "${profile.name}" (pid ${pid})`);

  // Build a proc-like object for compatibility. Playwright doesn't expose the raw process
  // for persistent contexts, so we create a minimal shim.
  const proc = createProcShim(context);

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
    engine: "firefox",
    profileName: profile.name,
  };
}

/**
 * Stop a running Firefox instance.
 */
export async function stopOpenClawFirefox(running: RunningBrowser): Promise<void> {
  const context = firefoxContexts.get(running.profileName);
  if (context) {
    try {
      await context.close();
    } catch {
      // ignore
    }
    firefoxContexts.delete(running.profileName);
  }
  // Also try killing the process directly
  try {
    running.proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Check if the Firefox Playwright context is still responsive.
 */
export async function isFirefoxReachable(profileName: string): Promise<boolean> {
  const context = firefoxContexts.get(profileName);
  if (!context) {
    return false;
  }
  try {
    const pages = context.pages();
    if (pages.length === 0) {
      return false;
    }
    // Try a lightweight operation to check responsiveness
    await pages[0].title();
    return true;
  } catch {
    return false;
  }
}

function extractPidFromContext(context: BrowserContext): number {
  // Playwright's BrowserContext from launchPersistentContext has a browser() method
  // whose underlying process may be accessible.
  try {
    const browser = context.browser();
    if (browser) {
      const proc = (browser as unknown as { process(): { pid?: number } | null }).process?.();
      if (proc?.pid) {
        return proc.pid;
      }
    }
  } catch {
    // ignore
  }
  return -1;
}

/**
 * Create a minimal ChildProcessWithoutNullStreams shim for Firefox.
 * Playwright manages the process internally, so this wraps the context lifecycle.
 */
function createProcShim(context: BrowserContext) {
  // EventEmitter, Readable, Writable imported at top level

  const emitter = new EventEmitter();
  let killed = false;
  let exitCode: number | null = null;

  // Watch for context close
  context.on("close", () => {
    killed = true;
    exitCode = 0;
    emitter.emit("exit", 0, null);
    emitter.emit("close", 0, null);
  });

  const shim = Object.assign(emitter, {
    stdin: new Writable({
      write(_chunk: unknown, _enc: unknown, cb: () => void) {
        cb();
      },
    }),
    stdout: new Readable({
      read() {
        /* no-op */
      },
    }),
    stderr: new Readable({
      read() {
        /* no-op */
      },
    }),
    get pid() {
      return extractPidFromContext(context);
    },
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    kill(signal?: string) {
      if (killed) {
        return true;
      }
      killed = true;
      context.close().catch(() => {});
      return true;
    },
    ref() {
      return shim;
    },
    unref() {
      return shim;
    },
    disconnect() {
      /* no-op */
    },
    get connected() {
      return !killed;
    },
    send() {
      return false;
    },
    [Symbol.dispose]() {
      /* no-op */
    },
  });

  return shim as unknown as import("node:child_process").ChildProcessWithoutNullStreams;
}
