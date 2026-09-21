import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { resolveWindowsOemCodePageForEncoding } from "./windows-encoding.js";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const WINDOWS_GIT_LAUNCHER_MARKER = "rem OpenClaw Git launcher";

type WindowsGitLauncherReconcileResult =
  | { status: "skipped"; reason: "not-windows" | "missing" | "foreign" }
  | { status: "needs-reinstall"; launcherPath: string }
  | { status: "needs-repair"; launcherPath: string }
  | { status: "unchanged"; launcherPath: string }
  | { status: "created" | "updated"; launcherPath: string };

function escapeCmdLiteral(value: string): string {
  if (value.includes("\u0000") || /[\r\n"]/u.test(value)) {
    throw new Error("Windows Git launcher paths cannot contain NUL, quotes, CR, or LF");
  }
  // Quoted batch arguments preserve carets, and delayed expansion is disabled
  // below so bangs stay literal. Percents still double to prevent expansion.
  return value.replaceAll("%", "%%");
}

/** Renders the persistent Windows Git launcher shared by install and update repair. */
function renderWindowsGitLauncher(params: { nodePath: string; entryPath: string }): string {
  const nodePath = escapeCmdLiteral(params.nodePath);
  const entryPath = escapeCmdLiteral(params.entryPath);
  return [
    "@echo off",
    WINDOWS_GIT_LAUNCHER_MARKER,
    "setlocal DisableDelayedExpansion",
    `if exist "${nodePath}" goto openclaw_runtime_ready`,
    "echo [!] OpenClaw's validated Node.js runtime is missing. 1>&2",
    "echo [i] Re-run the OpenClaw installer to repair this Git installation. 1>&2",
    "exit /b 1",
    ":openclaw_runtime_ready",
    `"${nodePath}" "${entryPath}" %*`,
    "",
  ].join("\r\n");
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value).toLowerCase();
}

function isManagedLauncherForEntry(content: string, entryPath: string): boolean {
  const normalizedEntryPath = normalizeWindowsPath(entryPath);
  const legacyMatch = /^@echo off\r?\nnode "([^"\r\n]+)" %\*(?:\r?\n)?$/u.exec(content);
  if (legacyMatch?.[1] && normalizeWindowsPath(legacyMatch[1]) === normalizedEntryPath) {
    return true;
  }
  const managedMatch =
    /^@echo off\r?\nrem OpenClaw Git launcher\r?\nsetlocal DisableDelayedExpansion\r?\nif exist "([^"\r\n]+)" goto openclaw_runtime_ready\r?\necho \[!\] OpenClaw's validated Node\.js runtime is missing\. 1>&2\r?\necho \[i\] Re-run the OpenClaw installer to repair this Git installation\. 1>&2\r?\nexit \/b 1\r?\n:openclaw_runtime_ready\r?\n"\1" "([^"\r\n]+)" %\*\r?\n$/u.exec(
      content,
    );
  const encodedNodePath = managedMatch?.[1];
  const encodedEntryPath = managedMatch?.[2];
  if (!encodedNodePath || !encodedEntryPath) {
    return false;
  }
  const decodedNodePath = encodedNodePath.replaceAll("%%", "%");
  const decodedEntryPath = encodedEntryPath.replaceAll("%%", "%");
  return (
    escapeCmdLiteral(decodedNodePath) === encodedNodePath &&
    escapeCmdLiteral(decodedEntryPath) === encodedEntryPath &&
    normalizeWindowsPath(decodedEntryPath) === normalizedEntryPath
  );
}

// The shared decoder consumes the marker; cmd.exe consumes the preamble. Both
// must name the same encoding before decoded text can establish launcher ownership.
function hasConsistentLauncherCodePage(buffer: Buffer): boolean {
  const [firstLine, secondLine] = buffer.toString("latin1").split("\n", 2);
  const preamble = /^@chcp (\d+) >nul\s*$/u.exec(firstLine ?? "");
  if (!preamble) {
    return true;
  }
  const marker = /^@rem openclaw-launcher-encoding=(\S+)\s*$/u.exec(secondLine ?? "");
  return (
    marker?.[1] !== undefined &&
    resolveWindowsOemCodePageForEncoding(marker[1]) === Number(preamble[1])
  );
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function restoreClaimedLauncher(recovery: string, launcherPath: string, next: string) {
  try {
    await fs.link(recovery, launcherPath);
  } catch (error) {
    // A restoration error must take precedence: the user needs the recovery path.
    await fs.unlink(next).catch(() => undefined);
    throw new Error(
      `Launcher changed during publication; original retained for recovery at ${recovery}`,
      { cause: error },
    );
  }
}

/** Claim and inspect the actual destination, then publish without replacing another owner. */
async function publishOwnedLauncher(
  launcherPath: string,
  expected: Buffer | null,
  content: Buffer,
): Promise<boolean> {
  const directory = path.dirname(launcherPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(directory, ".openclaw-launcher-"));
  const next = path.join(staging, "next.cmd");
  const recovery = path.join(staging, "original.cmd");
  let claimed = false;
  let published = false;
  try {
    const file = await fs.open(next, "wx", 0o700);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    // Probe the required filesystem capability before moving a working launcher.
    const linkProbe = path.join(staging, "link-probe.cmd");
    await fs.link(next, linkProbe);
    await fs.unlink(linkProbe);
    if (expected !== null) {
      try {
        // The private recovery name is unique. This introduces a brief absent-path
        // window, but no rename ever overwrites the public launcher.
        await fs.rename(launcherPath, recovery);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
      claimed = true;
      await syncDirectoryBestEffort(staging);
      await syncDirectoryBestEffort(directory);
      if (!(await fs.lstat(recovery)).isFile()) {
        throw new Error(`Launcher owner changed; inspect recovery at ${recovery}`);
      }
      if (!(await fs.readFile(recovery)).equals(expected)) {
        return false;
      }
    }
    try {
      // Hard-link publication is atomic and fails if *any* destination exists.
      // Both files are on the same volume; unsupported filesystems fail closed.
      await fs.link(next, launcherPath);
    } catch (error) {
      if (hasErrnoCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    published = true;
    // Preserve the previous publisher's best-effort directory durability before
    // removing recovery. Windows/filesystems without directory fsync remain best-effort.
    await syncDirectoryBestEffort(directory);
    return true;
  } finally {
    if (claimed && !published) {
      // Do not remove the claimed bytes or replace a concurrent winner.
      await restoreClaimedLauncher(recovery, launcherPath, next);
      await syncDirectoryBestEffort(directory);
    }
    await fs.rm(staging, { recursive: true });
    await syncDirectoryBestEffort(directory);
  }
}

/** Creates a Git launcher or migrates an existing installer-owned launcher. */
export async function reconcileWindowsGitLauncher(params: {
  root: string;
  repair: boolean;
  create?: boolean;
  nodePath?: string;
  entryPath?: string;
  launcherPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<WindowsGitLauncherReconcileResult> {
  if ((params.platform ?? process.platform) !== "win32") {
    return { status: "skipped", reason: "not-windows" };
  }
  const env = params.env ?? process.env;
  const nodePath = await resolveStableNodePath(params.nodePath ?? process.execPath);
  const entryPath = params.entryPath ?? path.join(params.root, "dist", "entry.js");
  const userProfile = normalizeOptionalString(env.USERPROFILE);
  const launcherPath =
    params.launcherPath ??
    path.join(
      userProfile
        ? path.resolve(userProfile)
        : resolveRequiredOsHomeDir(env, params.homedir ?? os.homedir),
      ".local",
      "bin",
      "openclaw.cmd",
    );
  const desired = renderWindowsGitLauncher({ nodePath, entryPath });
  const currentBuffer = await fs.readFile(launcherPath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (currentBuffer !== null && !hasConsistentLauncherCodePage(currentBuffer)) {
    return { status: "skipped", reason: "foreign" };
  }
  const current =
    currentBuffer === null ? null : decodeWindowsLauncherScript({ buffer: currentBuffer });

  if (current === null) {
    if (!params.create) {
      return { status: "skipped", reason: "missing" };
    }
  } else if (current !== desired && !isManagedLauncherForEntry(current, entryPath)) {
    return { status: "skipped", reason: "foreign" };
  }

  // A legacy PATH launcher can start Doctor through an arbitrary shadow Node.
  // Never turn that process into durable launcher authority without reproving it.
  const runtime = await resolveNodeRuntimeInfo(nodePath, env);
  if (runtime.status !== "supported" || !isSupportedOpenClawNodeVersion(runtime.version)) {
    return { status: "needs-reinstall", launcherPath };
  }
  if (current !== null && current !== desired && !params.repair) {
    return { status: "needs-repair", launcherPath };
  }

  await Promise.all([
    assertFile(nodePath, "Validated Node.js runtime"),
    assertFile(entryPath, "OpenClaw build entrypoint"),
  ]);
  // Matching launcher bytes do not prove the runtime or entrypoint still exists.
  if (current === desired) {
    return { status: "unchanged", launcherPath };
  }
  const published = await publishOwnedLauncher(
    launcherPath,
    currentBuffer,
    encodeWindowsLauncherScript({ format: "cmd", content: desired }),
  );
  if (!published) {
    return { status: "skipped", reason: "foreign" };
  }
  return { status: current === null ? "created" : "updated", launcherPath };
}
