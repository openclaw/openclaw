// Link this connection's profile to an OpenClaw ID: a device sign-in with `link`, after which
// the Gateway records the account on the profile (OCF-510). The dialog loads on demand.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveControlUiPaths } from "../../app/browser.ts";
import type { OpenClawIdLinkOutcome } from "./device-sign-in.ts";

/** Resolves with what linking did, or null when the sign-in dialog was closed first. */
export async function linkOpenClawIdToProfile(
  client: GatewayBrowserClient,
): Promise<OpenClawIdLinkOutcome | null> {
  const { showDeviceSignInDialog } =
    await import("../../components/openclaw-id/device-sign-in-dialog.tsx");
  const done = await showDeviceSignInDialog({
    client,
    basePath: resolveControlUiPaths(window.location.pathname)[0],
    link: true,
  });
  return done ? (done.link ?? null) : null;
}
