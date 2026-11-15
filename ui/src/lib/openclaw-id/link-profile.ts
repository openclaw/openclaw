// Link this connection's profile to an OpenClaw ID (OCF-510). When this browser still holds the
// account from a device sign-in, the Gateway links that one (OCF-530); otherwise, or when the
// Gateway no longer recognizes it, a device sign-in with `link` proves the account first. The
// dialog loads on demand.
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
} from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveControlUiPaths } from "../../app/browser.ts";
import { openClawIdAccount, readOpenClawIdSignOutGeneration } from "./account.ts";
import type { OpenClawIdLinkOutcome } from "./device-sign-in.ts";

/** Resolves with what linking did, or null when the sign-in dialog was closed first. */
export async function linkOpenClawIdToProfile(
  client: GatewayBrowserClient,
): Promise<OpenClawIdLinkOutcome | null> {
  const signedIn = openClawIdAccount();
  if (signedIn) {
    const signOutGeneration = readOpenClawIdSignOutGeneration();
    try {
      const result = await client.request<{ link: OpenClawIdLinkOutcome }>("openclawId.account", {
        action: "link_held",
        idToken: signedIn.idToken,
      });
      return result.link;
    } catch (error) {
      // The Gateway cannot reuse it (unknown, expired or not this profile's): sign in instead.
      if (
        !(error instanceof GatewayRequestError) ||
        resolveGatewayErrorDetailCode(error) !== "sign_in_not_held"
      ) {
        throw error;
      }
      // A sign-out while the Gateway answered retires this Link rather than starting a new one.
      if (readOpenClawIdSignOutGeneration() !== signOutGeneration) {
        throw new Error("You signed out while linking was in progress. Sign in again.", {
          cause: error,
        });
      }
    }
  }
  const { showDeviceSignInDialog } =
    await import("../../components/openclaw-id/device-sign-in-dialog.tsx");
  const done = await showDeviceSignInDialog({
    client,
    basePath: resolveControlUiPaths(window.location.pathname)[0],
    link: true,
  });
  return done ? (done.link ?? null) : null;
}
