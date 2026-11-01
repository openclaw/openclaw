// The per-claw loader owns the remote session. Its existing ocl-signout command
// drops the tunnel and clears the origin session, not the trusted device keys.
import { listen } from "../reactive/listener.ts";

/** Signs this browser out through the loader, then shows its signed-out screen. */
export async function signOutOfRemoteOpenClawId(): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) {
    throw new Error("The remote session is unavailable. Reload this page and try again.");
  }
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      stop();
      channel.port1.close();
      channel.port2.close();
      if (error) {
        reject(error);
      } else {
        resolve();
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
        finish(event.data?.ok === true ? undefined : new Error("The loader could not sign out."));
      },
      { once: true },
    );
    channel.port1.start();
    try {
      controller.postMessage({ type: "ocl-signout" }, [channel.port2]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // stay prevents the loader from immediately starting silent sign-in again.
  window.location.assign("/_loader/?stay=1");
}
