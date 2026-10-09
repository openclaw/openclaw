/** Platform storage diagnostics for Doctor state directories. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { shortenHomePath } from "../utils.js";

function resolvePathThroughExistingAncestor(
  targetPath: string,
  pathOps: Pick<typeof path, "resolve" | "dirname" | "basename">,
): string | null {
  const missingSegments: string[] = [];
  let candidate = pathOps.resolve(targetPath);
  while (true) {
    const resolved = safeRealpathSync(candidate);
    if (resolved) {
      return pathOps.resolve(resolved, ...missingSegments);
    }
    const parent = pathOps.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    missingSegments.unshift(pathOps.basename(candidate));
    candidate = parent;
  }
}

function escapeControlCharsForTerminal(value: string): string {
  const named: Record<string, string> = { "\r": "\\r", "\n": "\\n", "\t": "\\t" };
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127
      ? (named[char] ?? `\\x${code.toString(16).padStart(2, "0")}`)
      : char;
  }).join("");
}

type LinuxMountInfoEntry = {
  mountPoint: string;
  fsType: string;
  source: string;
};

type LinuxSdBackedStateDir = {
  path: string;
  mountPoint: string;
  fsType: string;
  source: string;
};

function parseLinuxMountInfo(rawMountInfo: string): LinuxMountInfoEntry[] {
  const entries: LinuxMountInfoEntry[] = [];
  for (const line of rawMountInfo.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(" - ");
    if (separatorIndex === -1) {
      continue;
    }

    const left = trimmed.slice(0, separatorIndex);
    const right = trimmed.slice(separatorIndex + 3);
    const leftFields = left.split(" ");
    const rightFields = right.split(" ");
    if (leftFields.length < 5 || rightFields.length < 2) {
      continue;
    }

    entries.push({
      mountPoint: decodeMountInfoPath(expectDefined(leftFields[4], "left fields entry at 4")),
      fsType: expectDefined(rightFields[0], "right fields entry at 0"),
      source: decodeMountInfoPath(expectDefined(rightFields[1], "right fields entry at 1")),
    });
  }
  return entries;
}

function isPathUnderRoot(
  targetPath: string,
  rootPath: string,
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse"> = path,
): boolean {
  const normalizedTarget = pathOps.resolve(targetPath);
  const normalizedRoot = pathOps.resolve(rootPath);
  const rootToken = pathOps.parse(normalizedRoot).root;
  if (normalizedRoot === rootToken) {
    return normalizedTarget.startsWith(rootToken);
  }
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${pathOps.sep}`)
  );
}

function findLinuxMountInfoEntryForPath(
  targetPath: string,
  entries: LinuxMountInfoEntry[],
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse">,
): LinuxMountInfoEntry | null {
  const normalizedTarget = pathOps.resolve(targetPath);
  let bestMatch: LinuxMountInfoEntry | null = null;
  for (const entry of entries) {
    if (!isPathUnderRoot(normalizedTarget, entry.mountPoint, pathOps)) {
      continue;
    }
    if (
      !bestMatch ||
      pathOps.resolve(entry.mountPoint).length > pathOps.resolve(bestMatch.mountPoint).length
    ) {
      bestMatch = entry;
    }
  }
  return bestMatch;
}

function isMmcDevicePath(devicePath: string, pathOps: Pick<typeof path, "basename">): boolean {
  const name = pathOps.basename(devicePath);
  return /^mmcblk\d+(?:p\d+)?$/.test(name);
}

function tryReadLinuxMountInfo(): string | null {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

function resolveLinuxStateMount(stateDir: string): LinuxSdBackedStateDir | null {
  const linuxPath = path.posix;
  const resolvedStatePath =
    resolvePathThroughExistingAncestor(stateDir, linuxPath) ?? linuxPath.resolve(stateDir);
  const mountInfo = tryReadLinuxMountInfo();
  const mountEntry = mountInfo
    ? findLinuxMountInfoEntryForPath(resolvedStatePath, parseLinuxMountInfo(mountInfo), linuxPath)
    : null;
  return mountEntry
    ? {
        path: linuxPath.resolve(resolvedStatePath),
        mountPoint: linuxPath.resolve(mountEntry.mountPoint),
        fsType: mountEntry.fsType,
        source: mountEntry.source,
      }
    : null;
}

/** Detects Linux state directories mounted from SD/eMMC-style block devices. */
export function detectLinuxSdBackedStateDir(stateDir: string): LinuxSdBackedStateDir | null {
  if (process.platform !== "linux") {
    return null;
  }
  const linuxPath = path.posix;
  const stateMount = resolveLinuxStateMount(stateDir);
  if (!stateMount) {
    return null;
  }

  const sourceCandidates = [stateMount.source];
  if (stateMount.source.startsWith("/dev/")) {
    const resolvedDevicePath = safeRealpathSync(stateMount.source);
    if (resolvedDevicePath) {
      sourceCandidates.push(linuxPath.resolve(resolvedDevicePath));
    }
  }
  if (!sourceCandidates.some((candidate) => isMmcDevicePath(candidate, linuxPath))) {
    return null;
  }

  return stateMount;
}

/** Formats the warning for state stored on SD/eMMC media. */
export function formatLinuxSdBackedStateDirWarning(
  displayStateDir: string,
  linuxSdBackedStateDir: LinuxSdBackedStateDir,
): string {
  const displayMountPoint =
    linuxSdBackedStateDir.mountPoint === "/"
      ? "/"
      : shortenHomePath(linuxSdBackedStateDir.mountPoint);
  const safeSource = escapeControlCharsForTerminal(linuxSdBackedStateDir.source);
  const safeFsType = escapeControlCharsForTerminal(linuxSdBackedStateDir.fsType);
  const safeMountPoint = escapeControlCharsForTerminal(displayMountPoint);
  return [
    `- State directory appears to be on SD/eMMC storage (${displayStateDir}; device ${safeSource}, fs ${safeFsType}, mount ${safeMountPoint}).`,
    "- SD/eMMC media can be slower for random I/O and wear faster under session/log churn.",
    "- For better startup and state durability, prefer SSD/NVMe (or USB SSD on Raspberry Pi) for OPENCLAW_STATE_DIR.",
  ].join("\n");
}

type LinuxVolatileStateDir = Omit<LinuxSdBackedStateDir, "source">;

/** Filesystems whose state disappears on reboot. Docker overlayfs is intentionally excluded. */
const VOLATILE_FS_TYPES = new Set(["tmpfs", "ramfs"]);

/** Detects Linux state directories mounted on filesystems that do not survive a reboot. */
export function detectLinuxVolatileStateDir(stateDir: string): LinuxVolatileStateDir | null {
  if (process.platform !== "linux") {
    return null;
  }
  const stateMount = resolveLinuxStateMount(stateDir);
  if (!stateMount || !VOLATILE_FS_TYPES.has(stateMount.fsType)) {
    return null;
  }
  const { source: _source, ...volatileStateMount } = stateMount;
  return volatileStateMount;
}

/** Formats the warning for state stored on a volatile Linux filesystem. */
export function formatLinuxVolatileStateDirWarning(
  displayStateDir: string,
  volatileDir: LinuxVolatileStateDir,
): string {
  const safeFsType = escapeControlCharsForTerminal(volatileDir.fsType);
  const safeMountPoint =
    volatileDir.mountPoint === "/"
      ? "/"
      : escapeControlCharsForTerminal(shortenHomePath(volatileDir.mountPoint));
  return [
    `- State directory is on a volatile filesystem (${displayStateDir}; fs ${safeFsType}, mount ${safeMountPoint}).`,
    "- Sessions, credentials, config, and SQLite state (including WAL/journal sidecars) will be lost on reboot.",
    "- Move OPENCLAW_STATE_DIR to a persistent filesystem to avoid data loss.",
  ].join("\n");
}

/** Detects macOS state directories under iCloud Drive or CloudStorage providers. */
export function detectMacCloudSyncedStateDir(stateDir: string): {
  path: string;
  storage: "iCloud Drive" | "CloudStorage provider";
} | null {
  if (process.platform !== "darwin") {
    return null;
  }

  // Cloud-sync roots should always be anchored to the OS account home on macOS.
  // OPENCLAW_HOME can relocate app data defaults, but iCloud/CloudStorage remain under the OS home.
  const homedir = os.homedir();
  const roots = [
    {
      storage: "iCloud Drive" as const,
      root: path.join(homedir, "Library", "Mobile Documents", "com~apple~CloudDocs"),
    },
    {
      storage: "CloudStorage provider" as const,
      root: path.join(homedir, "Library", "CloudStorage"),
    },
  ];
  // Missing state leaves must still follow existing symlink ancestors, like the Linux detectors.
  const resolvedStatePath =
    resolvePathThroughExistingAncestor(stateDir, path) ?? path.resolve(stateDir);

  for (const { storage, root } of roots) {
    if (isPathUnderRoot(resolvedStatePath, root)) {
      return { path: resolvedStatePath, storage };
    }
  }

  return null;
}

/** Detects Windows state directories under OneDrive sync roots. */
export function detectWindowsCloudSyncedStateDir(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  path: string;
  storage: "OneDrive" | "OneDrive for Business";
} | null {
  const platform = process.platform;
  if (platform !== "win32") {
    return null;
  }

  // The OneDrive sync client maintains these variables, so they are the
  // canonical sync-root source; path-shape heuristics would misfire on
  // ordinary local folders that merely contain "OneDrive" in a segment.
  const roots: { storage: "OneDrive" | "OneDrive for Business"; root: string }[] = [];
  const addRoot = (storage: "OneDrive" | "OneDrive for Business", root: string | undefined) => {
    if (root && root.trim() !== "") {
      roots.push({ storage, root });
    }
  };
  addRoot("OneDrive", resolveEnvironmentValue(env, "OneDrive", platform));
  addRoot("OneDrive", resolveEnvironmentValue(env, "OneDriveConsumer", platform));
  addRoot("OneDrive for Business", resolveEnvironmentValue(env, "OneDriveCommercial", platform));
  if (roots.length === 0) {
    return null;
  }

  // A state dir that does not exist yet cannot be resolved directly, and
  // falling back to the lexical path misreads a not-yet-created leaf beneath a
  // OneDrive-named junction that actually resolves to local storage. Resolve
  // through the nearest existing ancestor, as the Linux detectors do, so the
  // junction is followed even when the leaf is absent.
  const resolvedStatePath =
    resolvePathThroughExistingAncestor(stateDir, path) ?? path.resolve(stateDir);

  for (const { storage, root } of roots) {
    // Windows filesystems are case-insensitive by default; compare folded.
    if (isPathUnderRoot(resolvedStatePath.toLowerCase(), root.toLowerCase())) {
      return { path: resolvedStatePath, storage };
    }
  }

  return null;
}

type WindowsCloudSyncedStateDir = NonNullable<ReturnType<typeof detectWindowsCloudSyncedStateDir>>;

/** Formats the warning for state stored under a OneDrive sync root. */
export function formatWindowsCloudSyncedStateDirWarning(
  displayStateDir: string,
  windowsCloudSyncedStateDir: WindowsCloudSyncedStateDir,
): string {
  return [
    `- State directory is under Windows cloud-synced storage (${displayStateDir}; ${windowsCloudSyncedStateDir.storage}).`,
    "- This can cause slow I/O, sync/lock races, and Files On-Demand dehydration for sessions and credentials.",
    "- Prefer a local non-synced state dir (for example: %USERPROFILE%\\.openclaw).",
    // No one-shot `OPENCLAW_STATE_DIR=... openclaw doctor` hint here: that
    // retargets only the doctor process, while the managed Gateway keeps
    // using the synced directory, so it reads as a fix but is not one.
    "- To relocate: stop the Gateway, move the whole state directory, set",
    "  OPENCLAW_STATE_DIR to the new path for the Gateway service (not just",
    "  one shell), then restart it and re-run doctor to verify.",
  ].join("\n");
}
