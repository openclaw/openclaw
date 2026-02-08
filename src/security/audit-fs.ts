import fs from "node:fs/promises";
import {
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  type ExecFn,
} from "./windows-acl.js";

export type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  aclSummary?: string;
  error?: string;
};

export type PermissionCheckOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
};

export async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    const isSymlink = lst.isSymbolicLink();
    // For symlinks, use fs.stat to get the target's real permissions;
    // lstat returns the symlink's own mode (always 0o777 on POSIX).
    if (isSymlink) {
      try {
        const resolved = await fs.stat(targetPath);
        return {
          ok: true,
          isSymlink: true,
          isDir: resolved.isDirectory(),
          mode: typeof resolved.mode === "number" ? resolved.mode : null,
          uid: typeof resolved.uid === "number" ? resolved.uid : null,
          gid: typeof resolved.gid === "number" ? resolved.gid : null,
        };
      } catch (statErr) {
        // Broken symlink or inaccessible target — preserve isSymlink so
        // callers can distinguish broken symlinks from missing paths.
        return {
          ok: false,
          isSymlink: true,
          isDir: false,
          mode: null,
          uid: null,
          gid: null,
          error: String(statErr),
        };
      }
    }
    return {
      ok: true,
      isSymlink: false,
      isDir: lst.isDirectory(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      uid: typeof lst.uid === "number" ? lst.uid : null,
      gid: typeof lst.gid === "number" ? lst.gid : null,
    };
  } catch (err) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      uid: null,
      gid: null,
      error: String(err),
    };
  }
}

export async function inspectPathPermissions(
  targetPath: string,
  opts?: PermissionCheckOptions,
): Promise<PermissionCheck> {
  const st = await safeStat(targetPath);
  if (!st.ok) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      bits: null,
      source: "unknown",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
      error: st.error,
    };
  }

  const bits = modeBits(st.mode);
  const platform = opts?.platform ?? process.platform;

  if (platform === "win32") {
    const acl = await inspectWindowsAcl(targetPath, { env: opts?.env, exec: opts?.exec });
    if (!acl.ok) {
      return {
        ok: true,
        isSymlink: st.isSymlink,
        isDir: st.isDir,
        mode: st.mode,
        bits,
        source: "unknown",
        worldWritable: false,
        groupWritable: false,
        worldReadable: false,
        groupReadable: false,
        error: acl.error,
      };
    }
    return {
      ok: true,
      isSymlink: st.isSymlink,
      isDir: st.isDir,
      mode: st.mode,
      bits,
      source: "windows-acl",
      worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
      groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
      worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
      groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
      aclSummary: formatWindowsAclSummary(acl),
    };
  }

  return {
    ok: true,
    isSymlink: st.isSymlink,
    isDir: st.isDir,
    mode: st.mode,
    bits,
    source: "posix",
    worldWritable: isWorldWritable(bits),
    groupWritable: isGroupWritable(bits),
    worldReadable: isWorldReadable(bits),
    groupReadable: isGroupReadable(bits),
  };
}

export function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string {
  if (perms.source === "windows-acl") {
    const summary = perms.aclSummary ?? "unknown";
    return `${targetPath} acl=${summary}`;
  }
  return `${targetPath} mode=${formatOctal(perms.bits)}`;
}

export function formatPermissionRemediation(params: {
  targetPath: string;
  perms: PermissionCheck;
  isDir: boolean;
  posixMode: number;
  env?: NodeJS.ProcessEnv;
}): string {
  if (params.perms.source === "windows-acl") {
    return formatIcaclsResetCommand(params.targetPath, { isDir: params.isDir, env: params.env });
  }
  const mode = params.posixMode.toString(8).padStart(3, "0");
  return `chmod ${mode} ${params.targetPath}`;
}

export function modeBits(mode: number | null): number | null {
  if (mode == null) {
    return null;
  }
  return mode & 0o777;
}

export function formatOctal(bits: number | null): string {
  if (bits == null) {
    return "unknown";
  }
  return bits.toString(8).padStart(3, "0");
}

export function isWorldWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o002) !== 0;
}

export function isGroupWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o020) !== 0;
}

export function isWorldReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o004) !== 0;
}

export function isGroupReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o040) !== 0;
}
