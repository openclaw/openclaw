// The linked claw's own browser origin, https://<binding hostname> (OCF-276). The loader serves the
// Control UI there and its WebSocket reaches the Gateway only through the OpenClaw ID tunnel, so the
// Gateway accepts that origin for tunnel connections without a gateway.controlUi.allowedOrigins entry
// and without writing config. The hostname comes from the current owner-signed ServerBinding. The
// OpenClaw ID service publishes the resolver while remote access runs and it reads the live claw
// record, so a link adds the origin at once and a re-link or unlink replaces or removes it.

import type { StoredClaw } from "./claw-store.js";

/** Returns the linked claw's origin, or undefined while the claw is not linked. */
export type OpenClawIdClawOriginResolver = () => string | undefined;

let resolver: OpenClawIdClawOriginResolver | undefined;

/** Publishes or clears the resolver (the OpenClaw ID service does this while it is on). */
export function setOpenClawIdClawOriginResolver(
  next: OpenClawIdClawOriginResolver | undefined,
): void {
  resolver = next;
}

/**
 * The origin of a stored claw record: https://<hostname> from its owner-signed ServerBinding once the
 * claw is linked (it has an authority and a binding). A hostname only prepared for a link does not count.
 */
export function clawOriginOfRecord(
  record:
    | (Pick<StoredClaw, "authority"> & {
        binding: { body: { hostname: string } } | null;
      })
    | undefined,
): string | undefined {
  const hostname = record?.authority ? record.binding?.body.hostname : undefined;
  return hostname ? `https://${hostname}` : undefined;
}

// Normalizes an origin string for comparison; undefined for anything that is not a URL origin.
function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const origin = new URL(value.trim()).origin;
    return origin === "null" ? undefined : origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when `origin` is the linked claw's own origin. */
export function isOpenClawIdClawOrigin(origin: string | undefined): boolean {
  const claw = normalizedOrigin(resolver?.());
  return claw !== undefined && normalizedOrigin(origin) === claw;
}
