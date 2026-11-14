import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { clearMcpOAuthCredentials, startMcpOAuthAuthorization } from "../agents/mcp-oauth.js";
import type { ResolvedHttpMcpTransportConfig } from "../agents/mcp-transport-config.js";
import type { McpAuthEffectEndpoint } from "./server.mcp-auth-login.forced-effects.test-support.js";

export function registerMcpAuthRegistrationTests(fixture: {
  identity: () => McpOAuthIdentity;
  transport: () => ResolvedHttpMcpTransportConfig;
  browserLogin: (origin: string) => Promise<WizardNextResult>;
  requests: string[];
  effects: McpAuthEffectEndpoint;
}) {
  it.each([
    ["http://127.0.0.1:18789", "network", false],
    ["http://127.0.0.1:18789", "invalid_client_metadata", false],
    ["https://127.0.0.1:18789", "invalid_redirect_uri", true],
    ["https://localhost:18789", "invalid_redirect_uri", true],
    ["https://[::1]:18789", "invalid_redirect_uri", true],
    ["http://127.0.0.1:18789", "invalid_redirect_uri", false],
    ["https://gateway.example:8443", "invalid_redirect_uri", false],
    ["https://127.0.0.1:18789", "invalid_client_metadata", false],
    ["https://127.0.0.1:18789", "malformed", false],
  ] as const)("preserves callback %s and explains %s", async (origin, error, loopback) => {
    const identity = fixture.identity();
    await clearMcpOAuthCredentials(identity);
    const registrations: unknown[] = [];
    fixture.effects.endpoint = async (request, response) => {
      if (request.url !== "/register") {
        return false;
      }
      registrations.push(JSON.parse(await text(request)));
      if (error === "network") {
        request.socket.destroy();
      } else {
        response.writeHead(400).end(
          error === "malformed"
            ? "private-invalid-body"
            : JSON.stringify({
                error,
                error_description:
                  "private-registration-detail https://private.example/?code=secret",
              }),
        );
      }
      return true;
    };
    const remote = new URL(origin).hostname === "gateway.example";
    const redirectUrl = origin + "/oauth/provider/callback";
    try {
      const before = fixture.requests.length;
      if (remote) {
        // Explicit callbacks do not opt into the coordinator's localhost retry.
        await expect(
          startMcpOAuthAuthorization(
            identity,
            {
              ...fixture.transport(),
              oauth: { redirectUrl },
            },
            {},
          ),
        ).rejects.toMatchObject({ submittedMetadata: { redirect_uris: [redirectUrl] } });
      } else {
        const result = await fixture.browserLogin(origin);
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining(
            loopback
              ? "HTTPS loopback callback"
              : error === "network"
                ? "could not reach the sign-in service"
                : "rejected this connection's settings",
          ),
        });
        if (loopback) {
          expect(result.error).toContain("Keep Gateway TLS enabled");
          expect(result.error).toContain("reachable from this browser");
          expect(result.error).toContain("openclaw mcp login docs");
          expect(result.error).toContain("even if login fails");
        }
        expect(JSON.stringify(result)).not.toMatch(
          /private-registration-detail|private\.example|secret|private-invalid-body/,
        );
      }
      expect(registrations).toEqual([
        expect.objectContaining({
          redirect_uris: [redirectUrl],
          application_type: remote ? "web" : "native",
        }),
      ]);
      expect(fixture.requests.slice(before)).not.toContain("/token");
      const stored = await readMcpOAuthStore(identity.storeKey);
      expect(stored.tokens).toBeUndefined();
      expect([stored.codeVerifier, stored.lastAuthorizationUrl]).toEqual([undefined, undefined]);
    } finally {
      fixture.effects.endpoint = undefined;
    }
  });
}
