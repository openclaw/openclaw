import { parseStrictPositiveInteger } from "./parse-finite-number.js";

/** Highest valid TCP/UDP port number. */
export const MAX_TCP_PORT = 65_535;

/** Parse user/env port input as a strict TCP port, returning null for invalid values. */
export function parseTcpPort(raw: unknown): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    return null;
  }
  return parsed;
}
