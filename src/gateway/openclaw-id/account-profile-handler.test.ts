import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

const issuer = vi.hoisted(() => ({ nonce: "", invalidNonce: false, previewAccess: true }));
// Inject only external issuer I/O: the PKCE owner, token validation and storage are real.
vi.mock("./account-sign-in.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-sign-in.js")>();
  return {
    ...actual,
    createOpenClawIdSignIn: () =>
      actual.createOpenClawIdSignIn({
        fetchImpl: async (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith("/.well-known/openid-configuration")) {
            return Response.json({
              issuer: "https://issuer.example.test",
              authorization_endpoint: "https://issuer.example.test/authorize",
              token_endpoint: "https://issuer.example.test/token",
            });
          }
          if (url.endsWith("/v1/access")) {
            return Response.json({
              preview_access: issuer.previewAccess,
              email: "verified@example.test",
            });
          }
          const claims = {
            iss: "https://issuer.example.test",
            aud: "control-ui",
            sub: "acct-owner",
            nonce: issuer.invalidNonce ? "wrong" : issuer.nonce,
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: "verified@example.test",
            name: "Verified owner",
          };
          return Response.json({
            id_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
          });
        },
      }),
  };
});

const { openclawIdHandlers } = await import("../server-methods/openclaw-id.js");

describe("verified account profile RPC boundary", () => {
  it.each([
    [false, true],
    [true, true],
    [false, false],
  ])(
    "ignores browser profile fields (invalid nonce=%s, preview=%s)",
    async (invalidNonce, previewAccess) => {
      issuer.invalidNonce = invalidNonce;
      issuer.previewAccess = previewAccess;
      const claw = await linkedClaw();
      await claw.authority.recordDiscovery({ owner_account_id: "acct-owner" });
      const { service } = serviceFor(claw.authority);
      const call = async (params: Record<string, unknown>) => {
        const respond = vi.fn();
        await openclawIdHandlers["openclawId.authority"]!({
          params,
          client: { internal: { isLocalClient: true } },
          context: {
            openclawIdService: service,
            getRuntimeConfig: () => ({
              gateway: {
                openclawId: {
                  enabled: true,
                  issuerUrl: "https://issuer.example.test",
                  clientId: "control-ui",
                  discoveryUrl: "https://discovery.example.test",
                },
              },
            }),
          },
          respond,
        } as unknown as GatewayRequestHandlerOptions);
        return respond;
      };
      try {
        const begin = await call({
          action: "account_begin",
          redirectUri: "http://127.0.0.1:18789/openclaw-id/callback",
        });
        const pending = begin.mock.calls[0]![1] as { authorizationUrl: string; state: string };
        issuer.nonce = new URL(pending.authorizationUrl).searchParams.get("nonce")!;
        const complete = await call({
          action: "account_complete",
          state: pending.state,
          code: "issuer-code",
          account: { sub: "acct-owner", email: "forged@example.test", name: "Forged" },
          accountEmail: "forged@example.test",
          accountName: "Forged",
          idToken: "browser-assertion",
        });
        expect(complete.mock.calls[0]![0]).toBe(!invalidNonce);
        if (!invalidNonce) {
          expect(complete.mock.calls[0]![1]).toMatchObject({ previewAccess });
        }
        expect((await claw.store.read())?.owner_profile).toEqual(
          invalidNonce || !previewAccess
            ? undefined
            : {
                sub: "acct-owner",
                email: "verified@example.test",
                name: "Verified owner",
              },
        );
      } finally {
        await service.stop();
      }
    },
  );
});

it.each([undefined, false])(
  "rejects every authority action before touching its service while disabled: %s",
  async (enabled) => {
    const service = {
      publish: vi.fn(),
      submitStatement: vi.fn(),
      registerInvite: vi.fn(),
    };
    for (const action of ["publish", "submit", "register_invite", "account_begin", "device_mail"]) {
      const respond = vi.fn();
      await openclawIdHandlers["openclawId.authority"]!({
        params: { action },
        context: {
          openclawIdService: service,
          getRuntimeConfig: () => ({ gateway: { openclawId: { enabled } } }),
        },
        respond,
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    }
    for (const call of Object.values(service)) {
      expect(call).not.toHaveBeenCalled();
    }
  },
);
