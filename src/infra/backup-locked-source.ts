import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

const LOCKED_SOURCE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Names the recovery step when another process holds a backup source open. */
export function describeLockedBackupSource(error: unknown): string {
  const record = asOptionalRecord(error);
  const code = record?.code;
  const pathname = record?.path;
  if (typeof code !== "string" || !LOCKED_SOURCE_CODES.has(code) || typeof pathname !== "string") {
    return "";
  }
  // Managed profiles live at <state>/browser/<profile>/user-data; a running browser keeps
  // durable files such as Network/Cookies open (and locked on Windows).
  const parts = pathname.replaceAll("\\", "/").split("/");
  const userData = parts.lastIndexOf("user-data");
  const profile = userData >= 2 && parts[userData - 2] === "browser" ? parts[userData - 1] : "";
  return profile
    ? ` The OpenClaw-managed browser profile "${profile}" has ${pathname} open (${code}). Stop it with \`openclaw browser --browser-profile ${profile} stop\`, then retry the backup.`
    : ` Another process has ${pathname} open (${code}). Close it, then retry the backup.`;
}
