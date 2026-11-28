import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { findVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

type EnvValue = string | undefined | ((home: string) => string | undefined);
const homeEnvKeys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];

function setTempHome(base: string) {
  setTestEnvValue("HOME", base);
  setTestEnvValue("USERPROFILE", base);
  // Ensure tests using HOME isolation aren't affected by leaked OPENCLAW_HOME.
  deleteTestEnvValue("OPENCLAW_HOME");
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));
  const match = process.platform === "win32" ? base.match(/^([A-Za-z]:)(.*)$/) : null;
  if (match) {
    setTestEnvValue("HOMEDRIVE", expectDefined(match[1], "temp home regex capture 1"));
    setTestEnvValue("HOMEPATH", match[2] || "\\");
  }
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
  const reserved = envKeys.find((key) => homeEnvKeys.includes(key));
  if (reserved) {
    throw new Error(`withTempHome: use built-in home env (got ${reserved})`);
  }
  const { cleanupSessionStateForTest } = await import("../../test-utils/session-state-cleanup.js");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix ?? "openclaw-test-home-"));
  const stateDir = path.join(base, ".openclaw");
  const snapshot = captureEnv([...homeEnvKeys, "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", ...envKeys]);
  // A retained case must survive the runner's enclosing temp-root cleanup too.
  const releaseClaim = findVitestResourceOwner(base)?.claim();
  let initialized = false;
  let unjoinedWork = false;
  try {
    setTempHome(base);
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    for (const [key, raw] of Object.entries(opts.env ?? {})) {
      const value = typeof raw === "function" ? raw(base) : raw;
      if (value === undefined) {
        deleteTestEnvValue(key);
      } else {
        setTestEnvValue(key, value);
      }
    }
    initialized = true;
    return await fn(base);
  } catch (error) {
    unjoinedWork = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (initialized && !unjoinedWork && !opts.skipSessionCleanup) {
      await cleanupSessionStateForTest({ stateDir, rootPath: base }).catch(() => undefined);
    }
    snapshot.restore();
    // Retention belongs to the body; failed acquisition has no caller-owned home.
    if (!unjoinedWork && (!initialized || !opts.skipHomeCleanup)) {
      await fs
        .rm(base, {
          recursive: true,
          force: true,
          ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 50 } : {}),
        })
        .catch(() => undefined);
    }
    if (!unjoinedWork) {
      releaseClaim?.();
    }
  }
}
