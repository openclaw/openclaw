// Browser device-code pairing contract shared by the Gateway, the CLI, and the Control UI.

const BROWSER_PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BROWSER_PAIR_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u;

const BROWSER_PAIR_CODE_LENGTH = 8;
export const BROWSER_PAIR_ROUTE_PREFIX = "/__openclaw__/browser-pair";
export const BROWSER_PAIR_IDENTITY_REQUIRED_MESSAGE =
  "Browser-code pairing is unavailable when gateway.roles is configured because this sign-in does not verify a user identity. Use your Gateway's identity-aware sign-in instead, or ask an administrator for the supported sign-in method.";

export type BrowserPairAction = "start" | "collect" | "cancel";

/** Pick one code from random alphabet indexes supplied by the caller's secure source. */
export function buildBrowserPairCode(randomIndex: (exclusiveMax: number) => number): string {
  let code = "";
  for (let index = 0; index < BROWSER_PAIR_CODE_LENGTH; index += 1) {
    code += BROWSER_PAIR_CODE_ALPHABET[randomIndex(BROWSER_PAIR_CODE_ALPHABET.length)];
  }
  return code;
}

/** Accept what a person types: any case, with or without the separator. */
export function normalizeBrowserPairCode(input: string): string | null {
  const code = input.replace(/[\s-]/gu, "").toUpperCase();
  return BROWSER_PAIR_CODE_RE.test(code) ? code : null;
}

/**
 * `work:ABCD-EFGH` names the issuing Gateway's profile so a bare `openclaw pair` reaches it.
 * The prefix only routes the CLI; the eight random characters stay the whole secret-free code.
 */
export function formatBrowserPairCode(code: string, profile?: string | null): string {
  const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
  return profile ? `${profile}:${formatted}` : formatted;
}

/** Split typed input into its profile prefix (unvalidated) and the code text. */
export function splitBrowserPairCodeProfile(input: string): {
  profile: string | null;
  code: string;
} {
  const separator = input.indexOf(":");
  return separator < 0
    ? { profile: null, code: input }
    : { profile: input.slice(0, separator).trim(), code: input.slice(separator + 1) };
}

/** Short, display-only name for a browser's signing key. */
export function formatBrowserPairDeviceId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

/**
 * Bytes a browser signs to prove it holds its device key. `collect` and `cancel` are fresh by
 * construction because each covers the Gateway-issued request id. A replayed
 * `start` only refreshes a request whose credential remains bound to the key.
 */
export function buildBrowserPairPayload(params: {
  action: BrowserPairAction;
  deviceId: string;
  requestId?: string;
}): string {
  return ["openclaw-browser-pair-v1", params.action, params.deviceId, params.requestId ?? ""].join(
    "\n",
  );
}
