import path from "node:path";
import { NODE_SERVICE_KIND, resolveNodeLaunchAgentLabel } from "../daemon/constants.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

/** Node-local provider custody; never part of a Gateway launch or durable worker descriptor. */
export type NodeWorkerManagedIdentityTransport = Readonly<{ endpoint: string; header: string }>;

const PLATFORM_TRUST_KEYS = [
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
] as const;
export type NodeWorkerPlatformTrust = Readonly<
  Pick<NodeJS.ProcessEnv, (typeof PLATFORM_TRUST_KEYS)[number]>
>;

/** Existing trust settings captured by the dedicated node owner, never caller overrides. */
export function captureNodeWorkerPlatformTrust(source: NodeJS.ProcessEnv): NodeWorkerPlatformTrust {
  return Object.freeze({
    REQUESTS_CA_BUNDLE: source.REQUESTS_CA_BUNDLE,
    SSL_CERT_FILE: source.SSL_CERT_FILE,
    NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS,
    NODE_USE_SYSTEM_CA: source.NODE_USE_SYSTEM_CA,
  });
}

/** Restore admitted node trust after sanitization, replacing any caller-selected paths. */
export function applyNodeWorkerPlatformTrust(
  env: NodeJS.ProcessEnv,
  trust: NodeWorkerPlatformTrust,
): void {
  for (const key of PLATFORM_TRUST_KEYS) {
    delete env[key];
    if (trust[key] !== undefined) {
      env[key] = trust[key];
    }
  }
}

export function captureNodeWorkerManagedIdentityTransport(
  source: NodeJS.ProcessEnv,
): NodeWorkerManagedIdentityTransport | undefined {
  const endpoint = source.IDENTITY_ENDPOINT;
  const header = source.IDENTITY_HEADER;
  if (endpoint === undefined && header === undefined) {
    return undefined;
  }
  if (!endpoint?.trim() || !header?.trim()) {
    throw new Error("Worker managed-identity transport is incomplete");
  }
  registerSecretValueForRedaction(header);
  return Object.freeze({ endpoint, header });
}

/** Only an admitted dedicated host supplies provider transport after generic sanitization. */
export function snapshotNodeWorkerExecutionEnv(
  source: NodeJS.ProcessEnv,
  transport?: NodeWorkerManagedIdentityTransport,
  platformTrust?: NodeWorkerPlatformTrust,
): NodeJS.ProcessEnv {
  const snapshot = snapshotNodeWorkerEnv(source);
  if (platformTrust) {
    applyNodeWorkerPlatformTrust(snapshot, platformTrust);
  }
  if (transport) {
    snapshot.IDENTITY_ENDPOINT = transport.endpoint;
    snapshot.IDENTITY_HEADER = transport.header;
  }
  return snapshot;
}

/** Rehome an already-admitted execution environment without discarding its provider custody. */
export function nodeWorkerHomeEnv(source: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  const snapshot = { ...source };
  const windows = process.platform === "win32";
  for (const key of Object.keys(snapshot)) {
    if (
      (windows ? key.toUpperCase() : key) === "HOME" ||
      (windows && key.toUpperCase() === "USERPROFILE")
    ) {
      delete snapshot[key];
    }
  }
  snapshot.HOME = homeDir;
  if (windows) {
    snapshot.USERPROFILE = homeDir;
  }
  return snapshot;
}

const POSIX_WORKER_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
]);
const WINDOWS_WORKER_ENV_KEYS = new Set([
  ...POSIX_WORKER_ENV_KEYS,
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

/** Freeze the minimal non-secret environment inherited by node-host workers. */
export function snapshotNodeWorkerEnv(
  source: NodeJS.ProcessEnv,
  homeDir?: string,
): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  let snapshot: NodeJS.ProcessEnv = {};
  const retainedWindowsKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const normalized = windows ? key.toUpperCase() : key;
    const allowed =
      (windows ? WINDOWS_WORKER_ENV_KEYS : POSIX_WORKER_ENV_KEYS).has(normalized) ||
      normalized.startsWith("LC_");
    if (!allowed) {
      continue;
    }
    if (windows) {
      const previousKey = retainedWindowsKeys.get(normalized);
      if (previousKey) {
        delete snapshot[previousKey];
      }
      retainedWindowsKeys.set(normalized, key);
    }
    snapshot[key] = value;
  }
  if (homeDir) {
    snapshot = nodeWorkerHomeEnv(snapshot, homeDir);
  }
  const hostCacheFenced =
    source.NODE_DISABLE_COMPILE_CACHE !== undefined &&
    source.OPENCLAW_SERVICE_KIND === NODE_SERVICE_KIND &&
    source.OPENCLAW_LAUNCHD_LABEL === resolveNodeLaunchAgentLabel();
  const workerCacheDisabled = source.NODE_DISABLE_COMPILE_CACHE !== undefined && !hostCacheFenced;
  if (!workerCacheDisabled) {
    const requestedCache = hostCacheFenced ? undefined : source.NODE_COMPILE_CACHE?.trim();
    snapshot.NODE_COMPILE_CACHE =
      requestedCache || path.join(resolvePreferredOpenClawTmpDir(), "node-worker-compile-cache");
  } else {
    snapshot.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  // The supervised start gate is carried by Node IPC. Launcher respawns do not
  // inherit that channel, so workers must stay in the owned child process.
  snapshot.OPENCLAW_NO_RESPAWN = "1";
  return snapshot;
}
