import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { z } from "zod";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import {
  buildEncodedPowerShellArgs,
  buildPowerShellFailureCause,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "../infra/windows-powershell-spawn.js";
import { runExec } from "../process/exec.js";

const MACOS_REPLACEMENT_ACL_PERMISSIONS = new Set([
  "add_file",
  "add_subdirectory",
  "chown",
  "delete",
  "delete_child",
  "writesecurity",
]);
const WINDOWS_STAGING_ACCESS_RIGHTS = new Set([
  "F",
  "M",
  "RX",
  "R",
  "W",
  "D",
  "DE",
  "RC",
  "WDAC",
  "WO",
  "AS",
  "MA",
  "GR",
  "GW",
  "GE",
  "GA",
  "RD",
  "WD",
  "AD",
  "REA",
  "WEA",
  "X",
  "DC",
  "RA",
  "WA",
  "UNKNOWN",
]);
const WINDOWS_STAGING_REPLACEMENT_RIGHTS = new Set([
  "F",
  "M",
  "D",
  "DE",
  "WDAC",
  "WO",
  "MA",
  "GA",
  "DC",
  "UNKNOWN",
]);
const WINDOWS_TRUSTED_OWNER_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
]);
const WINDOWS_TRUSTED_ACCESS_SIDS = new Set([
  ...WINDOWS_TRUSTED_OWNER_SIDS,
  "S-1-3-0", // Creator Owner resolves to the trusted creator on inherited ACEs.
]);
// Windows descriptors can approach 64 KiB each; batched JSON and base64 need
// bounded aggregate headroom across every ancestor.
const WINDOWS_ACL_METADATA_MAX_BUFFER = 16 * 1024 * 1024;
const WINDOWS_SID_PATTERN = /^S-\d+-\d+(?:-\d+)+$/iu;
const WINDOWS_SID_SCHEMA = z
  .string()
  .regex(WINDOWS_SID_PATTERN)
  .transform((value) => value.toUpperCase());
const WINDOWS_PRINCIPAL_SCHEMA = z
  .string()
  .min(1)
  .transform((value) => value.toUpperCase());
const WINDOWS_ACCESS_ENTRY_SCHEMA = z
  .object({
    principal: WINDOWS_PRINCIPAL_SCHEMA,
    accessType: z.enum(["Allow", "Deny"]),
    rightsMask: z.number().int().nonnegative().max(0xffffffff),
    inheritanceFlags: z.string(),
    propagationFlags: z.string(),
  })
  .strict();
const WINDOWS_PATH_SECURITY_SCHEMA = z
  .object({
    currentUserSid: WINDOWS_SID_SCHEMA,
    paths: z
      .array(
        z
          .object({
            path: z.string().min(1),
            ownerSid: WINDOWS_SID_SCHEMA,
            entries: z.array(WINDOWS_ACCESS_ENTRY_SCHEMA).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
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
const WINDOWS_READ_RIGHTS_MASK =
  0x000001 | 0x000008 | 0x000020 | 0x000080 | 0x020000 | 0x10000000 | 0x20000000 | 0x80000000;
const WINDOWS_WRITE_RIGHTS_MASK =
  0x000002 |
  0x000004 |
  0x000010 |
  0x000040 |
  0x000100 |
  0x010000 |
  0x040000 |
  0x080000 |
  0x10000000 |
  0x40000000;
let macosTrustedAclPrincipalsPromise: Promise<ReadonlySet<string>> | undefined;

type WindowsAclEntry = {
  readonly principal: string;
  readonly rights: string[];
  readonly rawRights: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

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
  let security: z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>;
  try {
    security = await inspectWindowsPathSecurity(paths);
  } catch (error) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${rootPath}`, {
      cause: error,
    });
  }
  if (security.paths.length !== paths.length) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${rootPath}`);
  }
  for (const [index, pathname] of paths.entries()) {
    const pathSecurity = security.paths[index];
    if (!pathSecurity || path.resolve(pathSecurity.path) !== path.resolve(pathname)) {
      throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
    }
    assertTrustedWindowsAcl(pathname, index === 0, security.currentUserSid, pathSecurity);
  }
}

function assertTrustedWindowsAcl(
  pathname: string,
  requirePrivate: boolean,
  currentUserSid: string,
  security: z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>["paths"][number],
): void {
  const pathRole = requirePrivate ? "repository root" : "ancestor";
  if (security.ownerSid !== currentUserSid && !WINDOWS_TRUSTED_OWNER_SIDS.has(security.ownerSid)) {
    throw new Error(
      `Windows SQLite staging ${pathRole} is owned by an untrusted principal: ` +
        `path=${pathname} principal=${security.ownerSid}. ` +
        "Choose a local directory owned only by the current user or a trusted OS principal.",
    );
  }
  const allowedEntries = security.entries.filter((entry) => entry.accessType === "Allow");
  if (allowedEntries.length === 0) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
  }
  const unsafeEntry = allowedEntries
    .filter(
      (entry) =>
        entry.principal !== currentUserSid && !WINDOWS_TRUSTED_ACCESS_SIDS.has(entry.principal),
    )
    .map(windowsSecurityEntryToAclEntry)
    .find((entry) => windowsAclEntryPermitsUnsafeStagingAccess(entry, requirePrivate));
  if (unsafeEntry) {
    throw new Error(
      `Windows ACL permits untrusted SQLite staging access on ${pathRole}: ` +
        `path=${pathname} principal=${unsafeEntry.principal} rights=${unsafeEntry.rawRights}. ` +
        "Remove the untrusted grant or choose a private local directory; do not use a shared or synced root.",
    );
  }
}

function windowsSecurityEntryToAclEntry(
  entry: z.infer<typeof WINDOWS_ACCESS_ENTRY_SCHEMA>,
): WindowsAclEntry {
  const rights: string[] = WINDOWS_FILE_RIGHTS.filter(
    ([right]) => (entry.rightsMask & right) !== 0,
  ).map(([, name]) => name);
  if ((entry.rightsMask & ~WINDOWS_KNOWN_FILE_RIGHTS_MASK) !== 0) {
    rights.push("UNKNOWN");
  }
  const inheritanceFlags = new Set(entry.inheritanceFlags.split(",").map((flag) => flag.trim()));
  const propagationFlags = new Set(entry.propagationFlags.split(",").map((flag) => flag.trim()));
  const rawFlags = [
    inheritanceFlags.has("ObjectInherit") ? "(OI)" : "",
    inheritanceFlags.has("ContainerInherit") ? "(CI)" : "",
    propagationFlags.has("NoPropagateInherit") ? "(NP)" : "",
    propagationFlags.has("InheritOnly") ? "(IO)" : "",
  ].join("");
  return {
    principal: entry.principal,
    rights,
    rawRights: `${rawFlags}(${rights.join(",")})`,
    canRead: (entry.rightsMask & WINDOWS_READ_RIGHTS_MASK) !== 0,
    canWrite: (entry.rightsMask & WINDOWS_WRITE_RIGHTS_MASK) !== 0,
  };
}

function windowsAclEntryPermitsUnsafeStagingAccess(
  entry: WindowsAclEntry,
  requirePrivate: boolean,
): boolean {
  // Inherit-only ACEs on ordinary ancestors are covered when the protected
  // root is inspected. Private roots must also reject rights inherited by files.
  if (!requirePrivate && /\(IO\)/iu.test(entry.rawRights)) {
    return false;
  }
  const rights = entry.rights.map((right) => right.toUpperCase());
  const unsafeRights = requirePrivate
    ? WINDOWS_STAGING_ACCESS_RIGHTS
    : WINDOWS_STAGING_REPLACEMENT_RIGHTS;
  return (
    (requirePrivate && (entry.canWrite || entry.canRead)) ||
    rights.some((right) => unsafeRights.has(right))
  );
}

async function inspectWindowsPathSecurity(
  pathnames: readonly string[],
): Promise<z.infer<typeof WINDOWS_PATH_SECURITY_SCHEMA>> {
  const encodedPaths = Buffer.from(JSON.stringify(pathnames), "utf8").toString("base64");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')))`,
    "$pathSecurity = @($paths | ForEach-Object { $path = [string]$_; $acl = Get-Acl -LiteralPath $path; $entries = @($acl.Access | ForEach-Object { $identity = $_.IdentityReference; try { $principal = $identity.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principal = [string]$identity.Value }; $rightsMask = ([int64][int32]$_.FileSystemRights) -band 0xffffffffL; [pscustomobject]@{ principal = $principal; accessType = [string]$_.AccessControlType; rightsMask = $rightsMask; inheritanceFlags = [string]$_.InheritanceFlags; propagationFlags = [string]$_.PropagationFlags } }); [pscustomobject]@{ path = $path; ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; entries = $entries } })",
    "$payload = [pscustomobject]@{ currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; paths = $pathSecurity }",
    "$json = ConvertTo-Json -InputObject $payload -Compress -Depth 4",
    "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
  ].join("; ");
  const stdout = await runEncodedWindowsPowerShell(command, WINDOWS_ACL_METADATA_MAX_BUFFER);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
  } catch (error) {
    throw new Error("Unable to parse Windows ACL metadata.", { cause: error });
  }
  const result = WINDOWS_PATH_SECURITY_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new Error("Invalid Windows ACL metadata.", { cause: result.error });
  }
  return result.data;
}

async function runEncodedWindowsPowerShell(command: string, maxBuffer: number): Promise<string> {
  const powershell = resolveSystemBin("powershell");
  if (!powershell) {
    throw new Error("Unable to resolve PowerShell for Windows SQLite path security.");
  }
  try {
    const { stdout } = await runExec(powershell, buildEncodedPowerShellArgs(command), {
      // Inherited PowerShell 7 paths can shadow Get-Acl and its nested security module.
      env: { PSModulePath: path.win32.join(path.win32.dirname(powershell), "Modules") },
      timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
      maxBuffer,
    });
    return stdout;
  } catch (error) {
    throw buildPowerShellFailureCause(error);
  }
}
