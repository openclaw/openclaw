import { mergeProcessEnv } from "../infra/process-env.js";

const SERVICE_MANAGER_ENV_KEYS = new Set([
  // Native executable, home/account, temporary-file and output context.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_MONETARY",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  // Linux bus/account routing, unit lookup and native client operation controls.
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SYSTEM_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "SYSTEMD_UNIT_PATH",
  "SUDO_USER",
  "SUDO_UID",
  "SUDO_GID",
  "SYSTEMD_OFFLINE",
  "SYSTEMD_IN_CHROOT",
  "SYSTEMD_BUS_TIMEOUT",
  // Windows executable/DLL discovery, profile paths and current-account context.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
  "USERDOMAIN",
  // PowerShell reads this caller-selected module cache during child startup.
  "PSMODULEANALYSISCACHEPATH",
]);

/** Project native control children only; service definitions and payloads retain their full env. */
export function resolveServiceManagerEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const windows = process.platform === "win32";
  return Object.fromEntries(
    Object.entries(mergeProcessEnv([source])).filter(([key]) =>
      SERVICE_MANAGER_ENV_KEYS.has(windows ? key.toUpperCase() : key),
    ),
  );
}
