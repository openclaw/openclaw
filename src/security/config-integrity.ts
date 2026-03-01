import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  addAuditEntry,
  loadConfigIntegrityStore,
  saveConfigIntegrityStore,
  type ConfigIntegrityStore,
  type IntegrityActor,
} from "./config-integrity-store.js";

export type IntegrityHashAlgorithm = "sha256";

export type IntegrityVerifyResult =
  | { status: "ok"; hash: string }
  | { status: "tampered"; expectedHash: string; actualHash: string }
  | { status: "missing-baseline"; actualHash: string }
  | { status: "file-not-found" }
  | { status: "error"; error: string };

export function computeFileIntegrityHash(
  filePath: string,
  algorithm: IntegrityHashAlgorithm = "sha256",
): string {
  const content = fs.readFileSync(filePath);
  const digest = createHash(algorithm).update(content).digest("hex");
  return `${algorithm}:${digest}`;
}

/**
 * Timing-safe hash comparison to prevent side-channel leaks.
 * Both hashes are re-hashed with SHA-256 so lengths always match.
 */
function safeHashEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function verifyFileIntegrity(filePath: string, expectedHash: string): IntegrityVerifyResult {
  try {
    if (!fs.existsSync(filePath)) {
      return { status: "file-not-found" };
    }
    const actualHash = computeFileIntegrityHash(filePath);
    if (safeHashEqual(actualHash, expectedHash)) {
      return { status: "ok", hash: actualHash };
    }
    return { status: "tampered", expectedHash, actualHash };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}

/** Default files to track relative to stateDir. */
const DEFAULT_TRACKED_GLOBS = ["openclaw.json", "openclaw.yaml", "openclaw.json5"];

/** Discover tracked files that exist on disk. */
function resolveTrackedFiles(stateDir: string, extraFiles?: string[]): string[] {
  const candidates = [...DEFAULT_TRACKED_GLOBS, ...(extraFiles ?? [])];
  const result: string[] = [];
  for (const relPath of candidates) {
    const abs = path.resolve(stateDir, relPath);
    if (fs.existsSync(abs)) {
      result.push(relPath);
    }
  }
  return result;
}

export function verifyAllIntegrity(
  store: ConfigIntegrityStore,
  stateDir?: string,
): Map<string, IntegrityVerifyResult> {
  const dir = stateDir ?? resolveStateDir();
  const results = new Map<string, IntegrityVerifyResult>();

  // Check all files that have entries in the store
  for (const [relPath, entry] of Object.entries(store.entries)) {
    const abs = path.resolve(dir, relPath);
    const result = verifyFileIntegrity(abs, entry.hash);
    results.set(relPath, result);
  }

  // Also check default tracked files that exist but have no baseline
  const trackedFiles = resolveTrackedFiles(dir);
  for (const relPath of trackedFiles) {
    if (results.has(relPath)) {
      continue;
    }
    const abs = path.resolve(dir, relPath);
    const actualHash = computeFileIntegrityHash(abs);
    results.set(relPath, { status: "missing-baseline", actualHash });
  }

  return results;
}

export function updateFileIntegrityHash(
  store: ConfigIntegrityStore,
  filePath: string,
  actor: IntegrityActor,
  stateDir?: string,
): ConfigIntegrityStore {
  const dir = stateDir ?? resolveStateDir();
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(dir, filePath);
  // Normalize to forward slashes so store keys are consistent across platforms (Windows uses backslash).
  const relPath = path.relative(dir, abs).split(path.sep).join("/");

  if (!fs.existsSync(abs)) {
    return store;
  }

  const hash = computeFileIntegrityHash(abs);
  const stat = fs.statSync(abs);
  const isNew = !store.entries[relPath];

  const updatedEntries = {
    ...store.entries,
    [relPath]: {
      hash,
      updatedAt: Date.now(),
      updatedBy: actor,
      fileSize: stat.size,
    },
  };

  let updated: ConfigIntegrityStore = { ...store, entries: updatedEntries };
  updated = addAuditEntry(updated, {
    file: relPath,
    action: isNew ? "created" : "updated",
    hash,
    actor,
  });

  return updated;
}

export function verifyConfigIntegrityOnStartup(params: {
  config: OpenClawConfig;
  stateDir: string;
  onTampered?: (file: string, result: IntegrityVerifyResult) => void;
  onMissingBaseline?: (file: string) => void;
}): { allOk: boolean; results: Map<string, IntegrityVerifyResult> } {
  const { config, stateDir, onTampered, onMissingBaseline } = params;

  let store = loadConfigIntegrityStore(stateDir);
  const extraFiles = config.security?.configIntegrity?.trackedFiles;

  // Verify existing entries + discover tracked files without baselines first,
  // then create baselines for any missing files. This ensures onMissingBaseline
  // callbacks fire before baselines are created.
  const results = verifyAllIntegrity(store, stateDir);

  // Also check extra tracked files that may not be in the default set
  for (const relPath of extraFiles ?? []) {
    if (results.has(relPath)) {
      continue;
    }
    const abs = path.resolve(stateDir, relPath);
    if (!fs.existsSync(abs)) {
      continue;
    }
    if (!store.entries[relPath]) {
      const hash = computeFileIntegrityHash(abs);
      results.set(relPath, { status: "missing-baseline", actualHash: hash });
    } else {
      const result = verifyFileIntegrity(abs, store.entries[relPath].hash);
      results.set(relPath, result);
    }
  }

  let allOk = true;

  for (const [file, result] of results) {
    if (result.status === "tampered") {
      allOk = false;
      onTampered?.(file, result);
      store = addAuditEntry(store, {
        file,
        action: "tampered",
        hash: result.actualHash,
        actor: "gateway",
      });
    } else if (result.status === "missing-baseline") {
      onMissingBaseline?.(file);
      store = updateFileIntegrityHash(store, file, "gateway", stateDir);
    } else if (result.status === "ok") {
      store = addAuditEntry(store, {
        file,
        action: "verified-ok",
        hash: result.hash,
        actor: "gateway",
      });
    }
  }

  saveConfigIntegrityStore(store, stateDir);
  return { allOk, results };
}

/** Convenience: update the integrity hash for the main config file after a legitimate change. */
export function updateConfigIntegrityAfterWrite(actor: IntegrityActor, stateDir?: string): void {
  const dir = stateDir ?? resolveStateDir();
  const configPath = resolveConfigPath(undefined, dir);
  const relPath = path.relative(dir, configPath);

  let store = loadConfigIntegrityStore(dir);
  store = updateFileIntegrityHash(store, relPath, actor, dir);
  saveConfigIntegrityStore(store, dir);
}

export { type IntegrityActor } from "./config-integrity-store.js";
