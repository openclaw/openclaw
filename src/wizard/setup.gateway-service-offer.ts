import { resolveDaemonInstallBlockMessage } from "../cli/daemon-cli/shared.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";

/**
 * Whether this host can keep the managed service; otherwise onboarding stays in the foreground.
 * npx, pnpm dlx, and temp copies qualify: the install owner moves the service onto a durable copy.
 */
export async function canOfferGatewayServiceForOnboarding(): Promise<boolean> {
  if (resolveDaemonInstallBlockMessage("gateway") || resolveGatewayService().unsupportedReason) {
    return false;
  }
  return process.platform !== "linux" || (await isSystemdUserServiceAvailable());
}
