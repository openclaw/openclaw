import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import {
  readOwnerAndDaclBatch,
  type OwnerAndDaclResult,
  type WindowsAccessControlEntry,
} from "@openclaw/fs-safe/permissions";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { runExec } from "../process/exec.js";

const MACOS_REPLACEMENT_ACL_PERMISSIONS = new Set([
  "add_file",
  "add_subdirectory",
  "chown",
  "delete",
  "delete_child",
  "writesecurity",
]);
const WINDOWS_SYNCHRONIZE_RIGHT = 0x100000;
// Delete child/self, write DACL/owner, maximum allowed, and generic all.
const WINDOWS_STAGING_REPLACEMENT_RIGHTS_MASK =
  0x000040 | 0x010000 | 0x040000 | 0x080000 | 0x02000000 | 0x10000000;
const WINDOWS_TRUSTED_OWNER_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
]);
const WINDOWS_TRUSTED_ACCESS_SIDS = new Set([
  ...WINDOWS_TRUSTED_OWNER_SIDS,
  "S-1-3-0", // Creator Owner resolves to the trusted creator on inherited ACEs.
]);
const WINDOWS_FILE_RIGHTS = [
  [0x000001, "RD"],
  [0x000002, "WD"],
  [0x000004, "AD"],
  [0x000008, "REA"],
  [0x000010, "WEA"],
  [0x000020, "X"],
  [0x000040, "DC"],
  [0x000080, "RA"],
  [0x000100, "WA"],
  [0x010000, "D"],
  [0x020000, "RC"],
  [0x040000, "WDAC"],
  [0x080000, "WO"],
  [0x100000, "S"],
  [0x02000000, "MA"],
  [0x10000000, "GA"],
  [0x20000000, "GE"],
  [0x40000000, "GW"],
  [0x80000000, "GR"],
] as const;
const WINDOWS_KNOWN_FILE_RIGHTS_MASK = WINDOWS_FILE_RIGHTS.reduce(
  (mask, [right]) => mask | right,
  0,
);
let macosTrustedAclPrincipalsPromise: Promise<ReadonlySet<string>> | undefined;

export function assertDirectory(
  stat: Pick<Stats, "isSymbolicLink" | "isDirectory">,
  pathname: string,
  label: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

export async function assertDirectoryIdentity(
  directoryPath: string,
  expectedIdentity: FileIdentityStat,
): Promise<void> {
  const currentIdentity = await fs.lstat(directoryPath, {
    bigint: typeof expectedIdentity.dev === "bigint",
  });
  assertDirectory(currentIdentity, directoryPath, "SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite staging directory changed during operation: ${directoryPath}`);
  }
}

export function assertDirectoryIdentitySync(directoryPath: string, expectedIdentity: Stats): void {
  const currentIdentity = fsSync.lstatSync(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite staging directory changed during operation: ${directoryPath}`);
  }
}

export async function assertTrustedStagingRoot(
  expectedIdentity: FileIdentityStat,
  rootPath: string,
  options: { allowModeRepair?: boolean } = {},
): Promise<string> {
  const resolvedRootPath = path.resolve(rootPath);
  const trustedRootPath = await fs.realpath(resolvedRootPath);
  const rootIdentity = await fs.lstat(trustedRootPath, {
    bigint: typeof expectedIdentity.dev === "bigint",
  });
  assertDirectory(rootIdentity, trustedRootPath, "Private SQLite staging root");
  if (!sameFileIdentity(rootIdentity, expectedIdentity)) {
    throw new Error(`Private SQLite staging root changed during operation: ${resolvedRootPath}`);
  }
  if (process.platform === "win32") {
    await assertTrustedWindowsStagingPath(trustedRootPath);
    return trustedRootPath;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const unsafeMode = (Number(rootIdentity.mode) & 0o022) !== 0;
  if (
    uid === undefined ||
    Number(rootIdentity.uid) !== uid ||
    (unsafeMode && options.allowModeRepair !== true)
  ) {
    throw new Error(
      `Private SQLite staging root must be owned by the current user and not writable by other users: ${resolvedRootPath}`,
    );
  }
  if (process.platform === "darwin") {
    await assertTrustedMacosAcl(trustedRootPath, options.allowModeRepair !== true);
  }
  await assertTrustedPosixStagingAncestors(trustedRootPath, rootIdentity, uid);
  return trustedRootPath;
}

export async function assertPrivateStagingDirectory(
  expectedIdentity: Stats,
  directoryPath: string,
): Promise<void> {
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "Private SQLite staging directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`Private SQLite staging directory changed during operation: ${directoryPath}`);
  }
  if (process.platform === "win32") {
    // The parent root was already checked for private and inherit-only ACEs.
    // An untrusted principal cannot alter or replace children beneath that root.
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || currentIdentity.uid !== uid || (currentIdentity.mode & 0o077) !== 0) {
    throw new Error(`Private SQLite staging directory permissions are unsafe: ${directoryPath}`);
  }
  if (process.platform === "darwin") {
    await assertTrustedMacosAcl(directoryPath, true);
  }
}

async function assertTrustedPosixStagingAncestors(
  rootPath: string,
  rootIdentity: Pick<Stats | BigIntStats, "uid">,
  uid: number,
): Promise<void> {
  // A private root is still replaceable when one of its ancestors is writable
  // by another user. Sticky directories are safe only for user-owned children.
  let childIdentity = rootIdentity;
  let currentPath = path.dirname(rootPath);
  while (currentPath !== rootPath) {
    const currentIdentity = await fs.lstat(currentPath);
    assertDirectory(currentIdentity, currentPath, "SQLite staging ancestor");
    const writableByOtherUsers = (currentIdentity.mode & 0o022) !== 0;
    const ownerCanReplaceChild = currentIdentity.uid !== uid && currentIdentity.uid !== 0;
    const stickyOwnerIsTrusted = currentIdentity.uid === uid || currentIdentity.uid === 0;
    const stickyProtectsChild =
      (currentIdentity.mode & 0o1000) !== 0 &&
      stickyOwnerIsTrusted &&
      Number(childIdentity.uid) === uid;
    if (ownerCanReplaceChild || (writableByOtherUsers && !stickyProtectsChild)) {
      throw new Error(
        `SQLite staging ancestor must not allow another user to replace its child: ${currentPath}`,
      );
    }
    if (process.platform === "darwin") {
      await assertTrustedMacosAcl(currentPath, false);
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }
    childIdentity = currentIdentity;
    currentPath = parentPath;
  }
}

type MacosAclEntry = {
  effect: "allow" | "deny";
  permissions: ReadonlySet<string>;
  principal: string;
};

function parseMacosAclEntries(output: string, pathname: string): MacosAclEntry[] {
  const lines = output.split(/\r?\n/u);
  const header = lines.shift();
  if (!header) {
    throw new Error(`Unable to inspect macOS ACL for SQLite staging: ${pathname}`);
  }
  const entries: MacosAclEntry[] = [];
  for (const line of lines) {
    if (!/^\s*\d+:\s/u.test(line)) {
      continue;
    }
    const match = line.match(/^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?(allow|deny)\s+([a-z_,]+)\s*$/u);
    if (!match) {
      throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
    }
    const [, principal, effect, permissions] = match;
    if (!principal || !permissions || (effect !== "allow" && effect !== "deny")) {
      throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
    }
    entries.push({
      principal: normalizeAclPrincipal(principal),
      effect,
      permissions: new Set(permissions.split(",")),
    });
  }
  if (/^[^\s]{10}\+/u.test(header) && entries.length === 0) {
    throw new Error(`Unable to parse macOS ACL for SQLite staging: ${pathname}`);
  }
  return entries;
}

function normalizeAclPrincipal(principal: string): string {
  return principal.trim().toLowerCase();
}

async function resolveTrustedMacosAclPrincipals(): Promise<ReadonlySet<string>> {
  macosTrustedAclPrincipalsPromise ??= (async () => {
    const dsmemberutil = resolveSystemBin("dsmemberutil");
    if (!dsmemberutil) {
      throw new Error("Unable to resolve dsmemberutil for macOS ACL verification.");
    }
    const currentUsername = os.userInfo().username;
    const usernames = new Set([currentUsername, "root"]);
    const trusted = new Set<string>();
    for (const username of usernames) {
      const { stdout } = await runExec(dsmemberutil, ["getuuid", "-U", username], {
        timeoutMs: 5_000,
        maxBuffer: 64 * 1024,
      });
      const uuid = stdout.trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(uuid)) {
        throw new Error(`Unable to resolve trusted macOS ACL principal for ${username}.`);
      }
      trusted.add(normalizeAclPrincipal(uuid));
      trusted.add(normalizeAclPrincipal(username));
      trusted.add(normalizeAclPrincipal(`user:${username}`));
    }
    return trusted;
  })();
  return await macosTrustedAclPrincipalsPromise;
}

async function assertTrustedMacosAcl(pathname: string, requirePrivate: boolean): Promise<void> {
  const ls = resolveSystemBin("ls");
  if (!ls) {
    throw new Error(`Unable to verify macOS ACL for SQLite staging: ${pathname}`);
  }
  let entries: MacosAclEntry[];
  try {
    const [result, trustedPrincipals] = await Promise.all([
      runExec(ls, ["-lden", "--", pathname], {
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
      }),
      resolveTrustedMacosAclPrincipals(),
    ]);
    entries = parseMacosAclEntries(result.stdout, pathname).filter(
      (entry) => !trustedPrincipals.has(entry.principal),
    );
  } catch (error) {
    throw new Error(`Unable to verify macOS ACL for SQLite staging: ${pathname}`, {
      cause: error,
    });
  }
  const unsafeEntry = entries.find(
    (entry) =>
      entry.effect === "allow" &&
      (requirePrivate ||
        [...entry.permissions].some((permission) =>
          MACOS_REPLACEMENT_ACL_PERMISSIONS.has(permission),
        )),
  );
  if (unsafeEntry) {
    throw new Error(`macOS ACL permits untrusted SQLite staging access: ${pathname}`);
  }
}

async function assertTrustedWindowsStagingPath(rootPath: string): Promise<void> {
  const paths = [rootPath];
  let currentPath = path.dirname(rootPath);
  while (currentPath !== rootPath) {
    paths.push(currentPath);
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }
  let security: OwnerAndDaclResult[];
  try {
    security = await readOwnerAndDaclBatch(paths);
  } catch (error) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${rootPath}`, {
      cause: error,
    });
  }
  for (const [index, pathname] of paths.entries()) {
    const pathSecurity = security[index]!;
    if (
      pathSecurity.status !== "supported" ||
      !pathSecurity.isLocal ||
      !pathSecurity.daclPresent ||
      !pathSecurity.complete
    ) {
      throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
    }
    assertTrustedWindowsAcl(pathname, index === 0, pathSecurity);
  }
}

function assertTrustedWindowsAcl(
  pathname: string,
  requirePrivate: boolean,
  security: Extract<OwnerAndDaclResult, { status: "supported" }>,
): void {
  const pathRole = requirePrivate ? "repository root" : "ancestor";
  const currentUserSid = security.currentUserSid.toUpperCase();
  const ownerSid = security.ownerSid.toUpperCase();
  if (ownerSid !== currentUserSid && !WINDOWS_TRUSTED_OWNER_SIDS.has(ownerSid)) {
    throw new Error(
      `Windows SQLite staging ${pathRole} is owned by an untrusted principal: ` +
        `path=${pathname} principal=${ownerSid}. ` +
        "Choose a local directory owned only by the current user or a trusted OS principal.",
    );
  }
  const allowedEntries = security.aces.filter((entry) => entry.aceType === "allow");
  if (allowedEntries.length === 0) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
  }
  const unsafeMask = requirePrivate
    ? ~WINDOWS_SYNCHRONIZE_RIGHT
    : WINDOWS_STAGING_REPLACEMENT_RIGHTS_MASK | ~WINDOWS_KNOWN_FILE_RIGHTS_MASK;
  const unsafeEntry = allowedEntries.find((entry) => {
    const sid = entry.sid.toUpperCase();
    // Ancestor inherit-only grants are evaluated on the private root and its children.
    return (
      sid !== currentUserSid &&
      !WINDOWS_TRUSTED_ACCESS_SIDS.has(sid) &&
      (requirePrivate || !entry.flags.inheritOnly) &&
      (entry.mask & unsafeMask) !== 0
    );
  });
  if (unsafeEntry) {
    throw new Error(
      `Windows ACL permits untrusted SQLite staging access on ${pathRole}: ` +
        `path=${pathname} principal=${unsafeEntry.sid.toUpperCase()} rights=${formatWindowsSecurityRights(unsafeEntry)}. ` +
        "Remove the untrusted grant or choose a private local directory; do not use a shared or synced root.",
    );
  }
}

function formatWindowsSecurityRights(entry: WindowsAccessControlEntry): string {
  const rights: string[] = WINDOWS_FILE_RIGHTS.filter(([right]) => (entry.mask & right) !== 0).map(
    ([, name]) => name,
  );
  if ((entry.mask & ~WINDOWS_KNOWN_FILE_RIGHTS_MASK) !== 0) {
    rights.push("UNKNOWN");
  }
  const rawFlags = [
    entry.flags.objectInherit ? "(OI)" : "",
    entry.flags.containerInherit ? "(CI)" : "",
    entry.flags.noPropagateInherit ? "(NP)" : "",
    entry.flags.inheritOnly ? "(IO)" : "",
  ].join("");
  return `${rawFlags}(${rights.join(",")})`;
}
