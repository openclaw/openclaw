import os from "node:os";
import path from "node:path";
import { resolveGatewayStateDir } from "./paths.js";

/** Temporary root installed into managed service environments for this state. */
export function resolveServiceTmpDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    try {
      return path.join(resolveGatewayStateDir(env), "tmp");
    } catch {
      // Fall back to the same host temporary directory used by other platforms.
    }
  }
  return env.TMPDIR?.trim() || os.tmpdir();
}
