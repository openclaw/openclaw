import { pickPrimaryLanIPv4 } from "../gateway/net.js";
import { pickPrimaryTailnetIPv4 } from "./tailnet.js";

// Display helpers are best-effort wrappers around network discovery. Startup
// and config output should keep rendering even when interface probes fail.
/** Return a LAN IPv4 for display, or undefined when interface discovery fails. */
export function pickBestEffortPrimaryLanIPv4(): string | undefined {
  try {
    return pickPrimaryLanIPv4();
  } catch {
    return undefined;
  }
}

/** Return a tailnet IPv4 for display, or undefined when interface discovery fails. */
export function pickBestEffortPrimaryTailnetIPv4(): string | undefined {
  try {
    return pickPrimaryTailnetIPv4();
  } catch {
    return undefined;
  }
}
