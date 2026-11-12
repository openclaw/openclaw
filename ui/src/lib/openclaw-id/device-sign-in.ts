// A device sign-in for a connection whose browser the issuer cannot redirect to, such as a
// personal sign-in over Tailscale: the Gateway starts the grant and polls the issuer while
// this tab shows the user code. Loaded only with the device sign-in dialog, off the boot path.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { listen } from "../reactive/listener.ts";
import { keepOpenClawIdDeviceSignIn, readOpenClawIdSignOutGeneration } from "./account.ts";
import type { OpenClawIdSignedIn } from "./types.ts";

/** A device sign-in the Gateway started: the code to show and where to enter it. */
export type OpenClawIdDeviceSignIn = {
  state: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  interval: number;
  /** This origin's sign-out marker when the attempt began; a later sign-out retires it. */
  signOutGeneration: string | null | undefined;
};

/** Starts a device sign-in; the browser shows its code while `finishOpenClawIdDeviceSignIn` polls. */
export async function beginOpenClawIdDeviceSignIn(
  client: GatewayBrowserClient,
): Promise<OpenClawIdDeviceSignIn> {
  const signOutGeneration = readOpenClawIdSignOutGeneration();
  const started = await client.request<Omit<OpenClawIdDeviceSignIn, "signOutGeneration">>(
    "openclawId.account",
    { action: "device_begin" },
  );
  if (readOpenClawIdSignOutGeneration() !== signOutGeneration) {
    throw new Error("You signed out while sign-in was in progress. Start again.");
  }
  return { ...started, signOutGeneration };
}

// Resolves after `ms`, or rejects as soon as `signal` aborts.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Sign-in was cancelled.", { cause: signal.reason }));
      return;
    }
    const stop = listen(
      signal,
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new Error("Sign-in was cancelled.", { cause: signal.reason }));
      },
      { once: true },
    );
    const timer = window.setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

/** What linking the signed-in account to this profile did (Settings → Profile → Identity). */
export type OpenClawIdLinkOutcome =
  | "linked"
  | "linked_elsewhere"
  | "profile_changed"
  | "owner_profile";

/**
 * Asks the Gateway to poll the device sign-in until the user approves it, then keeps the
 * account like a popup sign-in. With `link`, the Gateway also links the account to this
 * connection's profile and reports the outcome. Rejects on denial, expiry, sign-out or
 * `signal` abort.
 */
export async function finishOpenClawIdDeviceSignIn(params: {
  client: GatewayBrowserClient;
  started: OpenClawIdDeviceSignIn;
  basePath: string;
  signal: AbortSignal;
  link?: boolean;
}): Promise<{ signedIn: OpenClawIdSignedIn; link?: OpenClawIdLinkOutcome }> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    if (readOpenClawIdSignOutGeneration() !== params.started.signOutGeneration) {
      throw new Error("You signed out while sign-in was in progress. Start again.");
    }
  };
  let interval = params.started.interval;
  for (;;) {
    if (Date.now() >= params.started.expiresAt) {
      throw new Error("Sign-in timed out. Try again.");
    }
    await pause(interval * 1000, params.signal);
    assertCurrent();
    const result = await params.client.request<
      | { pending: true; interval: number }
      | {
          account: Omit<OpenClawIdSignedIn, "idToken">;
          idToken: string;
          link?: OpenClawIdLinkOutcome;
        }
    >("openclawId.account", {
      action: "device_poll",
      state: params.started.state,
      ...(params.link ? { link: true } : {}),
    });
    assertCurrent();
    if ("pending" in result) {
      interval = result.interval;
      continue;
    }
    const signedIn = { ...result.account, idToken: result.idToken };
    keepOpenClawIdDeviceSignIn(
      signedIn,
      new URL(params.started.verificationUri).origin,
      params.basePath,
    );
    return { signedIn, ...(result.link ? { link: result.link } : {}) };
  }
}
