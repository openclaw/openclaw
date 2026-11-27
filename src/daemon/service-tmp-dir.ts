import os from "node:os";
import path from "node:path";
import { resolveGatewayStateDir } from "./paths.js";

/**
 * Temporary root installed into managed service environments for this state.
 *
 * Linux returns undefined when the installer has no TMPDIR, so the systemd unit
 * does not freeze the host default into an operator-looking TMPDIR. Consumers
 * that rank an explicit TMPDIR first (update staging) then see it as unset.
 */
export function resolveServiceTmpDir(
  env: Record<string, string | undefined>,
  platform: "darwin",
): string;
export function resolveServiceTmpDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined;
export function resolveServiceTmpDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "darwin") {
    try {
      return path.join(resolveGatewayStateDir(env), "tmp");
    } catch {
      // Fall back to the same host temporary directory used by other platforms.
    }
  }
  const explicit = env.TMPDIR?.trim();
  if (platform === "linux") {
    return explicit || undefined;
  }
  return explicit || os.tmpdir();
}
