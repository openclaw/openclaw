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
import { listen } from "../reactive/listener.ts";
import {
  OPENCLAW_ID_CALLBACK_KEY_PREFIX,
  OPENCLAW_ID_CALLBACK_PATH,
  type OpenClawIdCallbackMessage,
} from "./callback-contract.ts";
import type { OpenClawIdSignedIn } from "./types.ts";

const STORAGE_KEY = "openclaw.openclawId.account";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

// The stored account, or null when absent, malformed or within a minute of expiry.
function readStored(): OpenClawIdSignedIn | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as OpenClawIdSignedIn) : null;
    return value && typeof value.idToken === "string" && value.exp * 1000 > Date.now() + 60_000
      ? value
      : null;
  } catch {
    return null;
  }
}

const [account, setAccount] = createSignal<OpenClawIdSignedIn | null>(readStored());
const accountListeners = new Set<(value: OpenClawIdSignedIn | null) => void>();

/** Account lifecycle events for browser-owned work that must stop immediately on sign-out. */
export function subscribeOpenClawIdAccount(listener: (value: OpenClawIdSignedIn | null) => void) {
  accountListeners.add(listener);
  return () => {
    accountListeners.delete(listener);
  };
}

/** The signed-in account, re-checked for expiry on every read. */
export function openClawIdAccount(): OpenClawIdSignedIn | null {
  const current = account();
  if (current && current.exp * 1000 <= Date.now() + 60_000) {
    return null;
  }
  return current;
}

/** Forgets the account on this origin. */
export function signOutOfOpenClawId(): void {
  getSafeLocalStorage()?.removeItem(STORAGE_KEY);
  setAccount(null);
  accountListeners.forEach((listener) => listener(null));
}

// Stores and publishes a completed sign-in.
function keep(signedIn: OpenClawIdSignedIn): void {
  getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(signedIn));
  setAccount(signedIn);
  accountListeners.forEach((listener) => listener(signedIn));
}

/** The redirect URI this Control UI registers with the issuer. */
export function openClawIdRedirectUri(basePath: string): string {
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
  const popup = window.open("", "openclaw-id-sign-in", "popup,width=520,height=720");
  try {
    const started = await params.client.request<{ authorizationUrl: string; state: string }>(
      "openclawId.authority",
      { action: "account_begin", redirectUri: openClawIdRedirectUri(params.basePath) },
    );
    if (popup) {
      popup.location.href = started.authorizationUrl;
    } else {
      window.open(started.authorizationUrl, "openclaw-id-sign-in");
    }
    const returned = await awaitCallback(started.state);
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
  const result = await client.request<{ code: string }>("openclawId.authority", {
    action: "account_link_code",
    idToken: signedIn.idToken,
  });
  return result.code;
}
