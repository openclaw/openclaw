import fs from "node:fs/promises";
import { execFileUtf8 } from "./exec-file.js";

/** util-linux installs runuser in one of these root-owned locations; PATH is never consulted. */
const RUNUSER_PATHS = ["/usr/sbin/runuser", "/sbin/runuser"] as const;

/** A runuser executable that only root can replace, or nothing when this host has none. */
export async function findRootOwnedRunuser(): Promise<string | undefined> {
  for (const candidate of RUNUSER_PATHS) {
    const info = await fs.stat(candidate).catch(() => null);
    if (
      info?.isFile() &&
      info.uid === 0 &&
      (info.mode & 0o022) === 0 &&
      (info.mode & 0o100) !== 0
    ) {
      return candidate;
    }
  }
  return undefined;
}

/** runuser takes a login name, while systemd's User= also accepts a numeric UID. */
export async function resolveServiceAccountName(account: string): Promise<string> {
  if (!/^\d+$/u.test(account)) {
    return account;
  }
  const result = await execFileUtf8("/usr/bin/getent", ["passwd", account], { timeout: 1_000 });
  const fields = result.stdout.trim().split(":");
  const name = fields[0];
  if (
    result.code !== 0 ||
    result.termination !== "exit" ||
    fields.length !== 7 ||
    fields[2] !== account ||
    !name
  ) {
    throw new Error(
      `Cannot resolve service UID ${account} to a login name: ${result.stderr.trim() || "invalid NSS passwd entry"}`,
    );
  }
  return name;
}

/**
 * Root runs `argv` as a systemd unit's account, so privilege only goes down. runuser resets
 * HOME, SHELL, USER and LOGNAME for the account; callers pass a trusted environment and apply
 * anything the unit defines only after the switch.
 */
export function serviceAccountArgv(params: {
  runuser: string;
  account: string;
  argv: readonly string[];
}): string[] {
  return [params.runuser, "-u", params.account, "--", ...params.argv];
}
