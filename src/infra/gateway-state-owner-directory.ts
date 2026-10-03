import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveGatewayLockDirForCanonicalStateDir } from "../config/paths.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { applyPrivateModeSync } from "./private-mode.js";

export type StateOwnerDirectoryIdentity = { path: string; dev: bigint; ino: bigint };

/** State cleanup preserves this owner until destructive work and native handles settle. */
export function resolveGatewayStateOwnerPath(databasePath: string): string {
  const canonical = resolveIdentityPathViaExistingAncestorSync(databasePath);
  const uid = process.getuid?.();
  // The state directory is an ancestor of the freshly canonical database path.
  const directory =
    process.platform === "win32"
      ? path.join(
          os.homedir(),
          "AppData",
          "Local",
          "OpenClaw",
          "locks",
          uid === undefined ? "openclaw-state-owners" : `openclaw-state-owners-${uid}`,
        )
      : resolveGatewayLockDirForCanonicalStateDir(
          resolveOpenClawStateDirForDatabasePath(canonical),
        );
  return path.join(
    resolveIdentityPathViaExistingAncestorSync(directory),
    `state.${sha256HexPrefixCore(canonical, 16)}.lock`,
  );
}

export function ensureOwnerDirectory(
  directory: string,
  created?: StateOwnerDirectoryIdentity[],
): void {
  const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated && created) {
    // Windows mkdir returns a namespaced path even when its input has no prefix.
    const boundary = path.toNamespacedPath(firstCreated);
    const directories: StateOwnerDirectoryIdentity[] = [];
    for (let current = directory; ;) {
      const { dev, ino } = fs.lstatSync(current, { bigint: true });
      directories.push({ path: current, dev, ino });
      if (path.toNamespacedPath(current) === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Created state ownership directory is outside its expected ancestry");
      }
      current = parent;
    }
    for (const entry of directories) {
      const previous = created.findIndex((candidate) => candidate.path === entry.path);
      if (previous < 0) {
        created.push(entry);
      } else {
        created[previous] = entry;
      }
    }
  }
  const observed = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if (!observed.isDirectory() || (uid !== undefined && observed.uid !== uid)) {
    throw new Error("State ownership directory must be a user-owned real directory");
  }
  if (process.platform !== "win32" && (observed.mode & 0o7777) !== 0o700) {
    applyPrivateModeSync(directory, 0o700);
    if ((fs.lstatSync(directory).mode & 0o077) !== 0) {
      throw new Error("State ownership directory permissions are not private");
    }
  }
}

export function removeCreatedProjectionDirectories(
  directories: StateOwnerDirectoryIdentity[],
): void {
  let directory = directories[0];
  while (directory) {
    try {
      const observed = fs.lstatSync(directory.path, { bigint: true });
      if (
        observed.isDirectory() &&
        observed.dev === directory.dev &&
        observed.ino === directory.ino
      ) {
        fs.rmdirSync(directory.path);
      }
    } catch (error) {
      const code = extractErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
    directories.shift();
    directory = directories[0];
  }
}
