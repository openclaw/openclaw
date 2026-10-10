import fs from "node:fs/promises";
import os from "node:os";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { z } from "zod";
import { runCommandWithTimeout } from "../process/exec.js";

type SystemDisk = { path: string; totalBytes: number; availableBytes: number };
type MountedDisk = { path: string; identity: string };
type LinuxMount = MountedDisk & {
  parentId: string;
  device: string;
  root: string;
  type: string;
  source: string;
};

const windowsVolumeSchema = z.object({
  Path: z.string().min(1),
  Capacity: z.number().int().positive(),
  FreeSpace: z.number().int().nonnegative(),
});
const commandOptions = { timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 };
let snapshot: { expiresAt: number; pending: Promise<SystemDisk[] | undefined> } | undefined;
// Native filesystem requests outlive response timeouts; never accumulate collections.
let pendingCollection: Promise<SystemDisk[] | undefined> | undefined;

function visibleLinuxMounts(mounts: Map<string, LinuxMount>): LinuxMount[] {
  const childPaths = new Map<string, Set<string>>();
  for (const mount of mounts.values()) {
    if (mount.parentId !== mount.identity) {
      const paths = childPaths.get(mount.parentId) ?? new Set<string>();
      paths.add(mount.path);
      childPaths.set(mount.parentId, paths);
    }
  }
  const visiblePaths = new Map<string, LinuxMount>();
  for (const mount of mounts.values()) {
    // An overmount's parent is the mount immediately below it at the same path.
    if (childPaths.get(mount.identity)?.has(mount.path)) {
      continue;
    }
    let hidden = false;
    let child = mount;
    let parent = mounts.get(child.parentId);
    while (parent && parent !== child) {
      const siblings = childPaths.get(parent.identity);
      // A shallower sibling covers this child's directory; this also hides
      // descendants of a lower stacked mount, but not children of its top mount.
      for (let end = child.path.lastIndexOf("/"); end >= 0;) {
        const ancestorPath = child.path.slice(0, end) || "/";
        if (ancestorPath !== child.path && siblings?.has(ancestorPath)) {
          hidden = true;
          break;
        }
        if (end === 0) {
          break;
        }
        end = child.path.lastIndexOf("/", end - 1);
      }
      if (hidden) {
        break;
      }
      child = parent;
      parent = mounts.get(child.parentId);
    }
    if (!hidden) {
      visiblePaths.set(mount.path, mount);
    }
  }
  return [...visiblePaths.values()];
}

async function readMountedDiskPaths(platform: NodeJS.Platform): Promise<MountedDisk[] | undefined> {
  if (platform === "linux") {
    const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
    const mounts = new Map<string, LinuxMount>();
    for (const line of mountInfo.split("\n")) {
      const [mount, filesystem] = line.split(" - ");
      const [mountId, parentId, device, root, encodedPath] = (mount ?? "").split(" ");
      const [type, source] = (filesystem ?? "").split(" ");
      if (!mountId || !parentId || !device || !root || !encodedPath || !type || !source) {
        continue;
      }
      mounts.set(mountId, {
        identity: mountId,
        parentId,
        device,
        root,
        path: decodeMountInfoPath(encodedPath),
        type,
        source,
      });
    }
    const devices = new Map<string, MountedDisk & { root: string }>();
    for (const { identity, device, root, path: mountPath, type, source } of visibleLinuxMounts(
      mounts,
    )) {
      if (type === "squashfs" || mountPath === "/boot/efi" || mountPath === "/efi") {
        continue;
      }
      // Containers expose their writable storage through overlay at /; other
      // roots must meet the same local-disk predicate as ordinary mounts.
      const localDisk = source.startsWith("/dev/") || type === "zfs";
      if (!localDisk && !(mountPath === "/" && type === "overlay")) {
        continue;
      }
      const existing = devices.get(device);
      const wholeFilesystem = root === "/";
      const existingWholeFilesystem = existing?.root === "/";
      if (
        !existing ||
        (wholeFilesystem && !existingWholeFilesystem) ||
        (wholeFilesystem === existingWholeFilesystem &&
          (mountPath.length < existing.path.length ||
            (mountPath.length === existing.path.length && mountPath < existing.path)))
      ) {
        devices.set(device, { path: mountPath, root, identity });
      }
    }
    return [...devices.values()].map(({ path, identity }) => ({ path, identity }));
  }

  const { stdout, code } = await runCommandWithTimeout(["mount"], commandOptions);
  if (code !== 0) {
    return undefined;
  }
  return stdout.split("\n").flatMap((line) => {
    const match = /^(\/dev\/\S+) on (.+) \(([^)]+)\)$/.exec(line);
    if (!match) {
      return [];
    }
    const [, device, mountPath, flags] = match;
    return device &&
      mountPath &&
      flags?.split(", ").includes("local") &&
      (mountPath === "/" || !flags.split(", ").includes("nobrowse"))
      ? [{ path: mountPath, identity: device }]
      : [];
  });
}

async function readMountedDisk(
  mount: MountedDisk,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<SystemDisk | undefined> {
  signal.throwIfAborted();
  const device =
    platform === "darwin" ? (await fs.stat(mount.path, { bigint: true })).dev : undefined;
  signal.throwIfAborted();
  // APFS firmlinks can give / the Data volume device rather than its sealed snapshot.
  if (
    device !== undefined &&
    mount.path !== "/" &&
    device !== (await fs.stat(mount.identity, { bigint: true })).rdev
  ) {
    return undefined;
  }
  signal.throwIfAborted();
  const stats = await fs.statfs(mount.path, { bigint: true });
  signal.throwIfAborted();
  if (device !== undefined && (await fs.stat(mount.path, { bigint: true })).dev !== device) {
    return undefined;
  }
  // df -kP rounds fractional KiB up; bavail excludes blocks reserved for root.
  const totalBytes = Number(((stats.blocks * stats.frsize + 1023n) / 1024n) * 1024n);
  // libuv exposes f_bavail as uint64 even when the filesystem reports a deficit.
  const available = BigInt.asIntN(64, stats.bavail) * stats.frsize;
  const availableBytes = available <= 0n ? 0 : Number(((available + 1023n) / 1024n) * 1024n);
  return Number.isSafeInteger(totalBytes) && totalBytes > 0 && Number.isSafeInteger(availableBytes)
    ? { path: mount.path, totalBytes, availableBytes }
    : undefined;
}

async function collectSystemDisks(
  disks: SystemDisk[],
  signal: AbortSignal,
): Promise<SystemDisk[] | undefined> {
  const platform = os.platform();
  if (platform === "win32") {
    const { stdout, code } = await runCommandWithTimeout(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
          "Get-CimInstance Win32_Volume -Filter 'DriveType=2 OR DriveType=3' | ForEach-Object { " +
          "$volume = $_; $mount = if ($volume.DriveLetter) { $volume.DriveLetter + '\\' } else { " +
          "Get-CimAssociatedInstance -InputObject $volume -Association Win32_MountPoint " +
          "-ResultClassName Win32_Directory | Select-Object -ExpandProperty Name | Sort-Object | Select-Object -First 1 }; " +
          "if ($mount) { [pscustomobject]@{Path=$mount;Capacity=$volume.Capacity;FreeSpace=$volume.FreeSpace} } " +
          "} | ConvertTo-Json -Compress",
      ],
      commandOptions,
    );
    if (code !== 0) {
      return undefined;
    }
    const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
      const result = windowsVolumeSchema.safeParse(row);
      return result.success
        ? [
            {
              path: result.data.Path,
              totalBytes: result.data.Capacity,
              availableBytes: result.data.FreeSpace,
            },
          ]
        : [];
    });
  }
  if (platform !== "linux" && platform !== "darwin") {
    return undefined;
  }
  const paths = await readMountedDiskPaths(platform);
  if (!paths?.length) {
    return paths ? [] : undefined;
  }
  let failed = false;
  for (const mount of paths) {
    if (signal.aborted) {
      break;
    }
    try {
      const disk = await readMountedDisk(mount, platform, signal);
      signal.throwIfAborted();
      // A removed mount's directory can resolve to its parent filesystem. Mount
      // IDs stay valid for Btrfs subvolumes whose stat device differs from mountinfo.
      const currentPaths = platform === "linux" ? await readMountedDiskPaths(platform) : paths;
      signal.throwIfAborted();
      if (
        disk &&
        currentPaths?.some(
          (current) => current.path === mount.path && current.identity === mount.identity,
        )
      ) {
        disks.push(disk);
      }
    } catch {
      failed = true;
    }
  }
  return failed && disks.length === 0 ? undefined : disks;
}

async function collectDiskSnapshot(): Promise<SystemDisk[] | undefined> {
  if (pendingCollection) {
    // The previous partial response has expired. Do not republish stale mount
    // membership or queue more native work behind its blocked filesystem call.
    return undefined;
  }
  const disks: SystemDisk[] = [];
  const controller = new AbortController();
  const pending = collectSystemDisks(disks, controller.signal).finally(() => {
    pendingCollection = undefined;
  });
  pendingCollection = pending;
  try {
    // macOS previously had separate mount and df command budgets.
    const timeoutMs =
      os.platform() === "darwin" ? commandOptions.timeoutMs * 2 : commandOptions.timeoutMs;
    return await withTimeout(pending, timeoutMs);
  } catch {
    controller.abort();
    return disks.length > 0 ? disks : undefined;
  }
}

export function readSystemDisks(): Promise<SystemDisk[] | undefined> {
  const now = Date.now();
  if (!snapshot || now >= snapshot.expiresAt) {
    const next = {
      expiresAt: Infinity,
      pending: collectDiskSnapshot()
        .then((disks) => disks?.toSorted((left, right) => left.path.localeCompare(right.path)))
        .catch(() => undefined)
        .finally(() => {
          next.expiresAt = Date.now() + 30_000;
        }),
    };
    snapshot = next;
  }
  return snapshot.pending;
}
