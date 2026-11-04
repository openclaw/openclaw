import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDaemonInstallBlockMessage } from "../cli/daemon-cli/shared.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";

/** A service pointing into an npx, dlx, or temporary directory breaks when that copy is evicted. */
async function runsFromDisposableInstall(): Promise<boolean> {
  const realpath = (target: string) => fs.realpath(target).catch(() => path.resolve(target));
  const entrypoint = await realpath(process.argv[1] ?? "");
  const segments = entrypoint.split(path.sep);
  return (
    segments.includes("_npx") ||
    segments.includes("dlx") ||
    entrypoint.startsWith(`${await realpath(os.tmpdir())}${path.sep}`)
  );
}

/** Whether this host can keep the managed service; otherwise onboarding stays in the foreground. */
export async function canOfferGatewayServiceForOnboarding(): Promise<boolean> {
  if (
    resolveDaemonInstallBlockMessage("gateway") ||
    resolveGatewayService().unsupportedReason ||
    (await runsFromDisposableInstall())
  ) {
    return false;
  }
  return process.platform !== "linux" || (await isSystemdUserServiceAvailable());
}
