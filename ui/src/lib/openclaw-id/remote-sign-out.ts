// The per-claw loader owns the remote session. Its existing ocl-signout command
// drops the tunnel and clears the origin session, not the trusted device keys.
import { listen } from "../reactive/listener.ts";

/** Disconnects this claw in every tab, then ends this browser's OpenClaw ID issuer session. */
export async function signOutOfRemoteOpenClawId(): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) {
    throw new Error("The remote session is unavailable. Reload this page and try again.");
  }
  const logoutUrl = await new Promise<string>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error, url?: string) => {
      window.clearTimeout(timeout);
      stop();
      channel.port1.close();
      channel.port2.close();
      if (error) {
        reject(error);
      } else {
        resolve(url!);
      }
    };
    const timeout = window.setTimeout(
      () => finish(new Error("Sign-out was not confirmed. Reload this page and try again.")),
      10_000,
    );
    const stop = listen(
      channel.port1,
      "message",
      (event) => {
        // The worker has already fenced local access even when server revocation could not
        // be confirmed. Its configured issuer handoff still ends the browser's ID session.
        const url = event.data?.value?.logoutUrl;
        if (typeof url !== "string") {
          finish(new Error("The loader could not finish sign-out. Reload and try again."));
          return;
        }
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          finish(new Error("The loader returned an invalid sign-out address."));
          return;
        }
        if (
          target.protocol !== "https:" ||
          target.pathname !== "/logout" ||
          target.username ||
          target.password
        ) {
          finish(new Error("The loader returned an invalid sign-out address."));
          return;
        }
        finish(undefined, target.href);
      },
      { once: true },
    );
    channel.port1.start();
    try {
      controller.postMessage({ type: "ocl-signout", endIssuer: true }, [channel.port2]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  window.location.assign(logoutUrl);
}
