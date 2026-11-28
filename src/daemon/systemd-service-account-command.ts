import fs from "node:fs/promises";

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

/**
 * Root runs `argv` as a systemd unit's account, so privilege only goes down. With
 * `preserveEnvironment`, the child gets exactly the spawn environment the caller passes
 * (`-m`), which keeps secret values out of argv, where any local account could read them
 * through /proc; otherwise runuser resets HOME, SHELL, USER and LOGNAME for the account.
 */
export function serviceAccountArgv(params: {
  runuser: string;
  account: string;
  argv: readonly string[];
  preserveEnvironment?: boolean;
}): string[] {
  return [
    params.runuser,
    ...(params.preserveEnvironment ? ["-m"] : []),
    "-u",
    params.account,
    "--",
    ...params.argv,
  ];
}
