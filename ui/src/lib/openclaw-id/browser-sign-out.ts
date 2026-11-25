// Browser navigation to the issuer's CSRF-protected logout confirmation. This never mutates
// claw membership, remote access or approved device credentials.

/** Builds a top-level issuer logout URL from the verified sign-in's issuer and app base. */
export function browserSignOutUrl(issuer: string, returnTo: string): string {
  const origin = new URL(issuer);
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("OpenClaw ID sign-out is unavailable: invalid issuer.");
  }
  const target = new URL(returnTo);
  target.search = "openclaw_id_signed_out=1";
  target.hash = "";
  const url = new URL("/logout", origin);
  url.searchParams.set("return_to", target.href);
  return url.href;
}

/** Reads the issuer hint from the Gateway-verified ID token retained by this browser. */
export function signedInIssuer(idToken: string): string {
  const payload = idToken.split(".")[1];
  if (!payload) {
    throw new Error("OpenClaw ID sign-out is unavailable: no issuer.");
  }
  const decoded: unknown = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !("iss" in decoded) ||
    typeof decoded.iss !== "string"
  ) {
    throw new Error("OpenClaw ID sign-out is unavailable: no issuer.");
  }
  return decoded.iss;
}
