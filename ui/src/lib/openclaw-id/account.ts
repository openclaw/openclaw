// The OpenClaw ID account this Control UI origin is signed in with. Sign-in is
// an OIDC authorization code flow with PKCE in a popup: the Gateway builds the
// authorization URL and redeems the code (the issuer serves no CORS), the
// popup returns to <origin>/openclaw-id/callback and hands the code back
// through this origin's localStorage (a `storage` event in this tab), and the
// account (with its ID token) stays in localStorage until it expires or the
// owner signs out.
import { createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
} from "../open-external-url.ts";
import { listen } from "../reactive/listener.ts";
import { showToast } from "../toast.ts";
import { browserSignOutUrl, signedInIssuer } from "./browser-sign-out.ts";
import {
  OPENCLAW_ID_CALLBACK_KEY_PREFIX,
  OPENCLAW_ID_CALLBACK_PATH,
  type OpenClawIdCallbackMessage,
} from "./callback-contract.ts";
import type { OpenClawIdSignedIn } from "./types.ts";

const STORAGE_KEY = "openclaw.openclawId.account";
const SIGN_OUT_KEY = "openclaw.openclawId.signedOut";
const RETURN_KEY = "openclaw.openclawId.returnBase";
const ISSUER_KEY = "openclaw.openclawId.issuer";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

// This is an invalidation marker, not an authentication secret; it works on HTTP origins too.
const nextSignOutEpoch = () => `${Date.now()}:${Math.random()}`;

// The stored account, or null when absent, malformed or within a minute of expiry.
function readStored(): OpenClawIdSignedIn | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(STORAGE_KEY);
    // SAFETY: idToken and exp are checked below before the value is used.
    const value = raw ? (JSON.parse(raw) as OpenClawIdSignedIn) : null;
    return value && typeof value.idToken === "string" && value.exp * 1000 > Date.now() + 60_000
      ? value
      : null;
  } catch {
    return null;
  }
}

let currentAccount = readStored();
let accountEpoch = getSafeLocalStorage()?.getItem(SIGN_OUT_KEY);
const [account, setAccount] = createSignal<OpenClawIdSignedIn | null>(currentAccount);
const accountListeners = new Set<(value: OpenClawIdSignedIn | null) => void>();

// Storage is shared by this origin's tabs. Sign-out invalidates pending popup work as well as
// the rendered account; the initiating tab publishes directly because it gets no storage event.
function publishAccount(value: OpenClawIdSignedIn | null): void {
  currentAccount = value;
  accountEpoch = getSafeLocalStorage()?.getItem(SIGN_OUT_KEY);
  setAccount(value);
  accountListeners.forEach((listener) => listener(value));
}
listen(window, "storage", (event) => {
  if (event.key === SIGN_OUT_KEY || event.key === null) {
    publishAccount(null);
  } else if (event.key === STORAGE_KEY) {
    publishAccount(readStored());
  }
});

// Returning from issuer logout keeps the account absent without another issuer round trip.
if (new URL(window.location.href).searchParams.get("openclaw_id_signed_out") === "1") {
  getSafeLocalStorage()?.removeItem(STORAGE_KEY);
  getSafeLocalStorage()?.setItem(SIGN_OUT_KEY, nextSignOutEpoch());
  publishAccount(null);
  const clean = new URL(window.location.href);
  clean.searchParams.delete("openclaw_id_signed_out");
  window.history.replaceState(null, "", clean.href);
}

/** Account lifecycle events for browser-owned work that must stop immediately on sign-out. */
export function subscribeOpenClawIdAccount(listener: (value: OpenClawIdSignedIn | null) => void) {
  accountListeners.add(listener);
  return () => {
    accountListeners.delete(listener);
  };
}

/** The signed-in account, re-checked for expiry on every read. */
export function openClawIdAccount(): OpenClawIdSignedIn | null {
  account(); // Subscribe renderers to the projection; authority changes synchronously.
  const current = currentAccount;
  if (getSafeLocalStorage()?.getItem(SIGN_OUT_KEY) !== accountEpoch) {
    return null;
  }
  if (current && current.exp * 1000 <= Date.now() + 60_000) {
    return null;
  }
  return current;
}

/** Forgets this origin's account in every tab and ends this browser's issuer session. */
export function signOutOfOpenClawId(): void {
  const signedIn = currentAccount;
  const returnTo = getSafeLocalStorage()?.getItem(RETURN_KEY) ?? `${window.location.origin}/`;
  const issuer = getSafeLocalStorage()?.getItem(ISSUER_KEY);
  // Local retirement never depends on decoding a stored token or reaching the issuer.
  try {
    getSafeLocalStorage()?.removeItem(STORAGE_KEY);
    getSafeLocalStorage()?.setItem(SIGN_OUT_KEY, nextSignOutEpoch());
  } finally {
    publishAccount(null);
  }
  if (signedIn) {
    try {
      window.location.assign(
        browserSignOutUrl(issuer ?? signedInIssuer(signedIn.idToken), returnTo),
      );
    } catch {
      showToast({
        severity: "warning",
        message:
          "You are signed out here, but OpenClaw ID sign-out could not finish. Open OpenClaw ID to sign out there.",
      });
    }
  }
}

// Stores and publishes a completed sign-in.
function keep(signedIn: OpenClawIdSignedIn): void {
  getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(signedIn));
  publishAccount(signedIn);
}

/** The redirect URI this Control UI registers with the issuer. */
function openClawIdRedirectUri(basePath: string): string {
  return `${window.location.origin}${basePath.replace(/\/+$/, "")}${OPENCLAW_ID_CALLBACK_PATH}`;
}

// Resolves with the callback page's message for `state` (taking it out of
// storage), or rejects on timeout.
function awaitCallback(state: string): Promise<OpenClawIdCallbackMessage> {
  const key = `${OPENCLAW_ID_CALLBACK_KEY_PREFIX}${state}`;
  return new Promise<OpenClawIdCallbackMessage>((resolve, reject) => {
    let stopListening = () => {};
    const stop = () => {
      window.clearTimeout(timer);
      stopListening();
      getSafeLocalStorage()?.removeItem(key);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key || !event.newValue) {
        return;
      }
      stop();
      try {
        // SAFETY: this key is written only by the sign-in callback page with this message shape.
        resolve(JSON.parse(event.newValue) as OpenClawIdCallbackMessage);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error("Sign-in timed out. Try again."));
    }, SIGN_IN_TIMEOUT_MS);
    stopListening = listen(window, "storage", onStorage);
  });
}

/**
 * Signs in with OpenClaw ID in a popup. Call from a click so the popup is not
 * blocked: the window opens first and navigates once the Gateway returns the
 * authorization URL. Resolves with the account once the code is redeemed.
 */
export async function signInWithOpenClawId(params: {
  client: GatewayBrowserClient;
  basePath: string;
}): Promise<OpenClawIdSignedIn> {
  const signOutGeneration = getSafeLocalStorage()?.getItem(SIGN_OUT_KEY);
  const assertCurrent = () => {
    if (getSafeLocalStorage()?.getItem(SIGN_OUT_KEY) !== signOutGeneration) {
      throw new Error("You signed out while sign-in was in progress. Start again.");
    }
  };
  // Reserved while the click still counts as user activation; the callback answers through
  // localStorage, so the popup needs no opener.
  const popup = reserveExternalWindowForDeferredNavigation({ popup: { width: 520, height: 720 } });
  try {
    const started = await params.client.request<{ authorizationUrl: string; state: string }>(
      "openclawId.authority",
      { action: "account_begin", redirectUri: openClawIdRedirectUri(params.basePath) },
    );
    assertCurrent();
    getSafeLocalStorage()?.setItem(ISSUER_KEY, new URL(started.authorizationUrl).origin);
    if (popup) {
      popup.location.href = started.authorizationUrl;
    } else {
      openExternalUrlSafe(started.authorizationUrl);
    }
    const returned = await awaitCallback(started.state);
    assertCurrent();
    if (returned.error || !returned.code) {
      throw new Error("Sign-in did not finish. Try again.");
    }
    const done = await params.client.request<{
      account: Omit<OpenClawIdSignedIn, "idToken">;
      idToken: string;
    }>("openclawId.authority", {
      action: "account_complete",
      state: started.state,
      code: returned.code,
    });
    const signedIn = { ...done.account, idToken: done.idToken };
    assertCurrent();
    getSafeLocalStorage()?.setItem(
      RETURN_KEY,
      `${window.location.origin}${params.basePath.replace(/\/+$/, "")}/`,
    );
    keep(signedIn);
    return signedIn;
  } catch (error) {
    popup?.close();
    throw error;
  }
}

/** A one-time Discovery link code for the signed-in account, so Make reachable needs no paste. */
export async function requestOpenClawIdLinkCode(
  client: GatewayBrowserClient,
  signedIn: OpenClawIdSignedIn,
): Promise<string> {
  const epoch = getSafeLocalStorage()?.getItem(SIGN_OUT_KEY);
  const assertCurrent = () => {
    if (
      openClawIdAccount()?.idToken !== signedIn.idToken ||
      getSafeLocalStorage()?.getItem(SIGN_OUT_KEY) !== epoch
    ) {
      throw new Error("You signed out while linking was in progress. Sign in again.");
    }
  };
  assertCurrent();
  const result = await client.request<{ code: string }>("openclawId.authority", {
    action: "account_link_code",
    idToken: signedIn.idToken,
  });
  // An already-open dialog may outlive another tab's logout; never give it a late link code.
  assertCurrent();
  return result.code;
}
