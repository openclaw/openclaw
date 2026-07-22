// Proxy capture CA helpers create and inspect local capture CA certificates.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { runExec } from "../process/exec.js";

const DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS = 30_000;
const DEBUG_PROXY_CA_LOCK_WAIT_MS = DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS + 5_000;
const DEBUG_PROXY_CA_LOCK_POLL_MS = 50;
const DEBUG_PROXY_CA_LOCK_TOKEN_SUFFIX = ".lock";

// Ensure a short-lived root CA for local MITM debug proxy runs. Existing certs
// are reused within the cert dir so repeated starts do not prompt regeneration.
export async function ensureDebugProxyCa(certDir: string): Promise<{
  certPath: string;
  keyPath: string;
}> {
  fs.mkdirSync(certDir, { recursive: true });
  const certPath = path.join(certDir, "root-ca.pem");
  const keyPath = path.join(certDir, "root-ca-key.pem");
  if (debugProxyCaPairExists(certPath, keyPath)) {
    return { certPath, keyPath };
  }
  const releaseLock = await acquireDebugProxyCaGenerationLock(certDir);
  try {
    if (debugProxyCaPairExists(certPath, keyPath)) {
      return { certPath, keyPath };
    }
    cleanupDebugProxyCaFiles(certPath, keyPath);
    const openssl = resolveSystemBin("openssl");
    if (!openssl) {
      throw new Error("openssl is required to generate debug proxy certificates");
    }
    const tempSuffix = `.tmp-${process.pid}-${randomUUID()}`;
    const tempKeyPath = `${keyPath}${tempSuffix}`;
    const tempCertPath = `${certPath}${tempSuffix}`;
    try {
      // OpenSSL writes the key and cert independently. Keep those writes off the
      // reusable paths so a killed process cannot publish a partial CA pair.
      await runExec(
        openssl,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-days",
          "7",
          "-nodes",
          "-keyout",
          tempKeyPath,
          "-out",
          tempCertPath,
          "-subj",
          "/CN=OpenClaw Debug Proxy",
        ],
        { logOutput: false, timeoutMs: DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS },
      );
      fs.renameSync(tempKeyPath, keyPath);
      fs.renameSync(tempCertPath, certPath);
    } catch (err) {
      cleanupDebugProxyCaFiles(certPath, keyPath, tempCertPath, tempKeyPath);
      throw err;
    }
    return { certPath, keyPath };
  } finally {
    releaseLock();
  }
}

function debugProxyCaPairExists(certPath: string, keyPath: string): boolean {
  return fs.existsSync(certPath) && fs.existsSync(keyPath);
}

async function acquireDebugProxyCaGenerationLock(certDir: string): Promise<() => void> {
  const lockDir = path.join(certDir, ".root-ca-generation.lock");
  const deadline = Date.now() + DEBUG_PROXY_CA_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      const lockTokenPath = path.join(
        lockDir,
        `${process.pid}-${randomUUID()}${DEBUG_PROXY_CA_LOCK_TOKEN_SUFFIX}`,
      );
      try {
        fs.writeFileSync(lockTokenPath, String(Date.now()), { flag: "wx" });
      } catch (err) {
        releaseDebugProxyCaGenerationLock(lockDir, lockTokenPath);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw err;
      }
      return () => releaseDebugProxyCaGenerationLock(lockDir, lockTokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    if (reclaimAbandonedDebugProxyCaLock(lockDir)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for debug proxy CA generation lock");
    }
    await delay(DEBUG_PROXY_CA_LOCK_POLL_MS);
  }
}

function reclaimAbandonedDebugProxyCaLock(lockDir: string): boolean {
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(lockDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }

  const tokenEntries = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(DEBUG_PROXY_CA_LOCK_TOKEN_SUFFIX),
  );
  if (tokenEntries.length === 0) {
    if (entries.length > 0) {
      return false;
    }
    return reclaimEmptyAbandonedDebugProxyCaLockDir(lockDir, now);
  }
  if (tokenEntries.length !== entries.length) {
    return false;
  }

  const tokenPaths = tokenEntries.map((entry) => path.join(lockDir, entry.name));
  for (const tokenPath of tokenPaths) {
    try {
      const stat = fs.statSync(tokenPath);
      if (now - stat.mtimeMs < DEBUG_PROXY_CA_LOCK_WAIT_MS) {
        return false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return false;
    }
  }

  let removedToken = false;
  for (const tokenPath of tokenPaths) {
    try {
      fs.unlinkSync(tokenPath);
      removedToken = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return false;
      }
    }
  }
  if (!removedToken) {
    return true;
  }
  return removeEmptyDebugProxyCaLockDir(lockDir);
}

function reclaimEmptyAbandonedDebugProxyCaLockDir(lockDir: string, now: number): boolean {
  try {
    const stat = fs.statSync(lockDir);
    if (now - stat.mtimeMs < DEBUG_PROXY_CA_LOCK_WAIT_MS) {
      return false;
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return removeEmptyDebugProxyCaLockDir(lockDir);
}

function releaseDebugProxyCaGenerationLock(lockDir: string, lockTokenPath: string): void {
  try {
    fs.unlinkSync(lockTokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return;
    }
  }
  removeEmptyDebugProxyCaLockDir(lockDir);
}

function removeEmptyDebugProxyCaLockDir(lockDir: string): boolean {
  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function cleanupDebugProxyCaFiles(...files: string[]): void {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best effort cleanup preserves the original OpenSSL error path.
    }
  }
}
