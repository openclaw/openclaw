import { extractErrorCode, formatErrorMessage } from "./errors.js";

export function isCiaoMdnsServerClosedError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "ERR_SERVER_CLOSED") {
    return true;
  }

  const msg = formatErrorMessage(err).toLowerCase();
  if (!msg) {
    return false;
  }
  if (msg.includes("cannot send packets on a closed mdns server")) {
    return true;
  }
  return false;
}
