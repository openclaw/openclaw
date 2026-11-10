// The OpenClaw ID sign-in popup lands here (<origin>/openclaw-id/callback). It
// hands the issuer's code and state to the Control UI tab that opened it by
// writing them to this origin's localStorage under the state (the opener hears
// a `storage` event and removes the entry; this works even when the issuer's
// pages cut window.opener), then closes. The code is useless without the
// Gateway's PKCE verifier, and the state ties it to the sign-in that tab started.
import "./sign-in-callback.css";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  OPENCLAW_ID_CALLBACK_KEY_PREFIX,
  type OpenClawIdCallbackMessage,
} from "./callback-contract.ts";

/** Hands the callback's result to the opener tab and closes the popup. */
export function finishOpenClawIdCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const message: OpenClawIdCallbackMessage = {
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  };
  if (message.state) {
    getSafeLocalStorage()?.setItem(
      `${OPENCLAW_ID_CALLBACK_KEY_PREFIX}${message.state}`,
      JSON.stringify(message),
    );
  }
  // Drop the code from the address bar and history before closing.
  window.history.replaceState(null, "", window.location.pathname);
  const status = document.createElement("main");
  status.setAttribute("role", "status");
  status.textContent = message.error
    ? "Sign-in was not completed. You can close this window."
    : "Signed in. You can close this window.";
  // This entry point skips the application theme owner; use the same system-mode tokens.
  const mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.themeMode = mode;
  document.body.classList.add("openclaw-id-callback");
  document.body.replaceChildren(status);
  window.close();
}
