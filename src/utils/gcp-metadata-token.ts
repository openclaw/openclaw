import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Resolve a GCP identity token. Tries (in order):
 *
 * 1. **ADC** (Application Default Credentials) — works locally when
 *    `GOOGLE_APPLICATION_CREDENTIALS` points to a service account key file.
 *    Signs a JWT and exchanges it for an identity token via Google's OAuth2 endpoint.
 *
 * 2. **Metadata server** — works on GKE with Workload Identity Federation.
 *    The pod's KSA is projected as a GCP service account and the metadata
 *    server issues OIDC identity tokens scoped to the given audience.
 *
 * Returns null when neither path is available.
 */
export async function resolveGcpIdentityToken(
  audience: string,
  options?: { timeoutMs?: number },
): Promise<{ token: string; source: "adc" | "metadata" } | null> {
  const timeoutMs = options?.timeoutMs ?? 3_000;

  // Try ADC first (local dev with mounted service account key)
  const adcToken = await resolveFromAdc(audience, timeoutMs);
  if (adcToken) {
    return { token: adcToken, source: "adc" };
  }

  // Fall back to metadata server (GKE)
  const metadataToken = await resolveFromMetadata(audience, timeoutMs);
  if (metadataToken) {
    return { token: metadataToken, source: "metadata" };
  }

  return null;
}

/**
 * Resolve an identity token from a service account key file (ADC).
 *
 * Reads the key from GOOGLE_APPLICATION_CREDENTIALS, creates a self-signed
 * JWT with target_audience claim, and exchanges it at Google's OAuth2 endpoint
 * for an identity token.
 */
async function resolveFromAdc(audience: string, timeoutMs: number): Promise<string | null> {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    return null;
  }

  try {
    const raw = await readFile(credPath, "utf-8");
    const creds = JSON.parse(raw);

    // Only service_account type supports identity token exchange
    if (creds.type !== "service_account" || !creds.private_key || !creds.client_email) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: creds.client_email,
      sub: creds.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 300,
      target_audience: audience,
    };

    // Create self-signed JWT
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const unsigned = `${header}.${body}`;
    const signature = sign("sha256", Buffer.from(unsigned), creds.private_key);
    const jwt = `${unsigned}.${signature.toString("base64url")}`;

    // Exchange for identity token
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { id_token?: string };
      return data.id_token?.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/**
 * Resolve an identity token from the GCP metadata server.
 */
async function resolveFromMetadata(audience: string, timeoutMs: number): Promise<string | null> {
  const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(metadataUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const token = (await response.text()).trim();
    return token || null;
  } catch {
    // Not running on GCP or metadata server not available
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Derive an HTTPS audience URL from a WebSocket URL.
 *
 * wss://host/ws → https://host
 * ws://host/ws  → http://host
 */
export function audienceFromWsUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/?$/, "");
}
