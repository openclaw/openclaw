import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Names the recovery step when a backup source is in use or not readable. */
export function describeLockedBackupSource(error: unknown): string {
  const record = asOptionalRecord(error);
  const code = record?.code;
  const pathname = record?.path;
  if (typeof pathname !== "string" || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) {
    return "";
  }
  // Managed profiles live at <state>/browser/<profile>/user-data; a running browser keeps
  // durable files such as Network/Cookies open (and locked on Windows).
  const parts = pathname.replaceAll("\\", "/").split("/");
  const userData = parts.lastIndexOf("user-data");
  const profile = userData >= 2 && parts[userData - 2] === "browser" ? parts[userData - 1] : "";
  const browserStep = profile
    ? ` If the OpenClaw-managed browser profile "${profile}" is running, stop it with \`openclaw browser --browser-profile ${profile} stop\`, then retry the backup.`
    : "";
  if (code === "EBUSY") {
    return ` ${pathname} is in use by another process (EBUSY).${browserStep || " Close that process, then retry the backup."}`;
  }
  // Access denials can be permissions, or a Windows sharing lock surfaced as EPERM.
  return ` ${pathname} could not be read (${code}). Check that this user can read it.${browserStep}`;
}
