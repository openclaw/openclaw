// Shared between the sign-in popup's callback document and the tab that opened it.

/**
 * localStorage key prefix the callback writes its result under, followed by
 * the sign-in's state. The opener tab hears it as a `storage` event.
 */
export const OPENCLAW_ID_CALLBACK_KEY_PREFIX = "openclaw.openclawId.callback.";
/** The callback route, relative to the Control UI base path. */
export const OPENCLAW_ID_CALLBACK_PATH = "/openclaw-id/callback";

/** What the callback page hands back: the issuer's code or error for a state. */
export type OpenClawIdCallbackMessage = {
  state: string | null;
  code: string | null;
  error: string | null;
};
