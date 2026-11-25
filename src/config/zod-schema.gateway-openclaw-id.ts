import { z } from "zod";
import { isValidPortalIngressDomain } from "./gateway-portal-ingress.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// HTTPS everywhere; plain HTTP only for loopback testbeds.
function isServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

const ServiceUrlSchema = z
  .string()
  .trim()
  .refine(isServiceUrl, "must be an https URL (http only for localhost testbeds)");

/**
 * Experimental OpenClaw ID remote access (Labs). Off unless `enabled` is true;
 * while off the Gateway starts no tunnel child, opens no sockets and makes no
 * calls to OpenClaw ID, Discovery or relays.
 */
export const GatewayOpenClawIdConfigSchema = z.strictObject({
  /** Labs switch. Default: false. */
  enabled: z.boolean().optional(),
  /** OpenClaw ID issuer used to sign in for identity only. */
  issuerUrl: ServiceUrlSchema.optional(),
  /** Public OAuth client (PKCE) the Control UI signs in with from its account menu. */
  clientId: z.string().trim().min(1).max(128).optional(),
  /** Discovery mirror and per-claw mailbox. */
  discoveryUrl: ServiceUrlSchema.optional(),
  /** The only iroh relay in the tunnel endpoint's relay map. */
  relayUrl: ServiceUrlSchema.optional(),
  /** Loader domain; a linked claw is served at https://<name>-<account tag>.<loaderDomain>. */
  loaderDomain: z
    .string()
    .trim()
    .refine(isValidPortalIngressDomain, "must be a bare DNS domain")
    .optional(),
  /** Days an owner device may go unused before its claw drops it. Default: 90. */
  ownerDeviceInactivityDays: z.number().int().min(1).max(3650).optional(),
  /** Days a member's browser may go unused before its claw drops it. Default: 30. */
  memberDeviceInactivityDays: z.number().int().min(1).max(3650).optional(),
});
