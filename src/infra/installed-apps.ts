import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import pLimit from "p-limit";

const execFileAsync = promisify(execFile);
const PLIST_READ_CONCURRENCY = 8;
const PLIST_READ_TIMEOUT_MS = 2_000;

const SYSTEM_APP_NAMES = new Set([
  "Calendar",
  "Contacts",
  "FaceTime",
  "Home",
  "Mail",
  "Maps",
  "Messages",
  "Music",
  "Notes",
  "Photos",
  "Podcasts",
  "Reminders",
  "Shortcuts",
]);

export type InstalledApp = {
  label: string;
  bundleId?: string;
  path: string;
  system: boolean;
};

export type InstalledAppsResult =
  | { status: "ok"; apps: InstalledApp[] }
  | { status: "unsupported"; platform: NodeJS.Platform; apps: [] };

type InstalledAppRoots = {
  applications: string;
  userApplications: string;
  systemApplications: string;
};

type ScanInstalledAppsOptions = {
  platform?: NodeJS.Platform;
  roots?: InstalledAppRoots;
};

function defaultRoots(): InstalledAppRoots {
  return {
    applications: "/Applications",
    userApplications: path.join(os.homedir(), "Applications"),
    systemApplications: "/System/Applications",
  };
}

function isBackupishBundle(label: string): boolean {
  return (
    /(?:^|[\s._-])(?:backup|previous|rollback)(?:[\s._-]|$)/i.test(label) ||
    /(?:^|[\s._-])pre-[\p{L}\p{N}._-]+$/iu.test(label)
  );
}

async function listAppPaths(
  root: string,
  system: boolean,
): Promise<Array<{ path: string; system: boolean }>> {
  const { entries } = await walkDirectory(root, {
    maxDepth: 1,
    symlinks: "follow",
    include: (entry) => {
      if (entry.kind !== "directory" || !entry.name.toLowerCase().endsWith(".app")) {
        return false;
      }
      const label = entry.name.slice(0, -4);
      return !isBackupishBundle(label) && (!system || SYSTEM_APP_NAMES.has(label));
    },
  });
  return entries.map((entry) => ({ path: entry.path, system }));
}

async function readBundleIdWithPlutil(appPath: string): Promise<string | undefined> {
  try {
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-expect", "string", plistPath],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: PLIST_READ_TIMEOUT_MS },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function scanInstalledApps(
  options: ScanInstalledAppsOptions = {},
): Promise<InstalledAppsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "unsupported", platform, apps: [] };
  }

  const roots = options.roots ?? defaultRoots();
  const appPaths = (
    await Promise.all([
      listAppPaths(roots.applications, false),
      listAppPaths(roots.userApplications, false),
      listAppPaths(roots.systemApplications, true),
    ])
  ).flat();
  const limit = pLimit(PLIST_READ_CONCURRENCY);
  const apps = await Promise.all(
    appPaths.map((entry) =>
      limit(async (): Promise<InstalledApp> => {
        const bundleId = await readBundleIdWithPlutil(entry.path);
        return {
          label: path.basename(entry.path, ".app"),
          ...(bundleId ? { bundleId } : {}),
          path: entry.path,
          system: entry.system,
        };
      }),
    ),
  );
  return {
    status: "ok",
    apps: apps.toSorted(
      (left, right) =>
        left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
        left.path.localeCompare(right.path),
    ),
  };
}
