// Temp home test helpers create isolated OpenClaw home directories for plugin tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { findVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

type EnvValue = string | undefined | ((home: string) => string | undefined);

function setTempHome(base: string) {
  setTestEnvValue("HOME", base);
  setTestEnvValue("USERPROFILE", base);
  // Ensure tests using HOME isolation aren't affected by leaked OPENCLAW_HOME.
  deleteTestEnvValue("OPENCLAW_HOME");
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));

  if (process.platform !== "win32") {
    return;
  }
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return;
  }
  setTestEnvValue("HOMEDRIVE", expectDefined(match[1], "temp home regex capture 1"));
  setTestEnvValue("HOMEPATH", match[2] || "\\");
}

export async function withTempHomeCore<T>(
  fn: (home: string) => Promise<T>,
  opts: {
    env?: Record<string, EnvValue>;
    prefix?: string;
    skipHomeCleanup?: boolean;
    skipSessionCleanup?: boolean;
  } = {},
): Promise<T> {
  const envKeys = Object.keys(opts.env ?? {});
  for (const key of envKeys) {
    if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") {
      throw new Error(`withTempHome: use built-in home env (got ${key})`);
    }
  }
  const { cleanupSessionStateForTest } = await import("../../test-utils/session-state-cleanup.js");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix ?? "openclaw-test-home-"));
  const snapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    ...envKeys,
  ]);
  // A retained case must survive the runner's enclosing temp-root cleanup too.
  const releaseClaim = findVitestResourceOwner(base)?.claim();
  let initialized = false;
  let unjoinedWork = false;
  try {
    setTempHome(base);
    await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });
    if (opts.env) {
      for (const [key, raw] of Object.entries(opts.env)) {
        const value = typeof raw === "function" ? raw(base) : raw;
        if (value === undefined) {
          deleteTestEnvValue(key);
        } else {
          setTestEnvValue(key, value);
        }
      }
    }
    initialized = true;
    return await fn(base);
  } catch (error) {
    unjoinedWork = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (initialized && !unjoinedWork && !opts.skipSessionCleanup) {
      await cleanupSessionStateForTest({
        stateDir: path.join(base, ".openclaw"),
        rootPath: base,
      }).catch(() => undefined);
    }
    snapshot.restore();
    // Retention belongs to the body; failed acquisition has no caller-owned home.
    if (!unjoinedWork && (!initialized || !opts.skipHomeCleanup)) {
      try {
        if (process.platform === "win32") {
          await fs.rm(base, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
          });
        } else {
          await fs.rm(base, {
            recursive: true,
            force: true,
          });
        }
      } catch {
        // ignore cleanup failures in tests
      }
    }
    if (!unjoinedWork) {
      releaseClaim?.();
    }
  }
}
