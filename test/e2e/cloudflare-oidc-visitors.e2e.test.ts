import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeVisitorFixtures,
  DAY_MS,
  guestRole,
  NOW,
  visitorFixture,
  visitorGrant,
} from "../../extensions/visitor-access/test-api.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayAuth } from "../../src/gateway/auth.js";
import {
  accessOrigin,
  accessRequest,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "../../src/gateway/github-user-identity.oidc.test-support.js";
import { resolveAuthenticatedHttpUserProfile } from "../../src/gateway/http-auth-user-profile.js";
import { checkGatewayHttpRequestAuth } from "../../src/gateway/http-auth-utils.js";
import { GatewayOperatorAccessDeniedError } from "../../src/gateway/operator-access-policy.js";
import { GatewayConnectionWork } from "../../src/gateway/server-connection-work.js";
import { attachGatewayWsConnectionHandler } from "../../src/gateway/server/ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestSocket,
} from "../../src/gateway/server/ws-connection.test-helpers.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { resolveUserProfileGitHubAttribution } from "../../src/state/user-profile-github-identity.js";
import { prepareUserProfileCatalog } from "../../src/state/user-profile-list.js";
import { getUserProfileListItem } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createDeferred, withinTest } from "../helpers/promise.js";

afterEach(async () => {
  closeVisitorFixtures();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("Cloudflare OIDC and Visitor Access admission", () => {
  it("admits an invited email without optional GitHub enrichment while enforcing current access requirements", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const grant = visitorGrant("ada@example.test");
      const visitor = visitorFixture({ grants: [grant], emails: [grant.email] });
      await visitor.service.initialize();
      const { config, registry } = createPluginRegistryFixture();
      let requiresGitHub = false;
      registerVirtualTestPlugin({
        registry,
        config,
        id: "visitor-access",
        name: "Visitor access",
        register(api) {
          api.registerGatewayAccessPolicy({
            authorize({ profile, requiredByRole }) {
              if (!requiredByRole) {
                return undefined;
              }
              if (requiresGitHub && !getUserProfileListItem(profile.profileId).githubIdentity) {
                throw new Error("Verified GitHub identity required");
              }
              return visitor.service.authorize(profile.emails);
            },
          });
        },
      });
      setActivePluginRegistry(registry.registry);
      const invitedCfg: OpenClawConfig = {
        gateway: {
          ...githubCfg.gateway,
          roles: { default: "guest", definitions: { guest: guestRole } },
        },
      };
      let claim = "01";
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) =>
          url === `${accessOrigin}/cdn-cgi/access/get-identity`
            ? identityResponse(oidcIdentity(claim, "custom"))
            : identityResponse({}, 503),
        );
      const request = accessRequest(grant.email, invitedCfg);
      const catalog = await prepareUserProfileCatalog();
      try {
        const admitted = await resolveAuthenticatedHttpUserProfile(request);
        const profileId = admitted.authenticatedUserProfile!.profileId;
        expect(getUserProfileListItem(profileId)).toMatchObject({
          emails: [grant.email],
          githubIdentity: null,
        });
        expect(admitted.operatorRolePolicy?.scopes).toEqual(guestRole.scopes);
        expect(admitted.operatorAccessAuthority).toBeTruthy();
        expect((await resolveUserProfileGitHubAttribution([profileId])).get(profileId)).toBeNull();
        expect(transport).toHaveBeenCalledOnce();

        requiresGitHub = true;
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toBeInstanceOf(
          GatewayOperatorAccessDeniedError,
        );
        claim = "101";
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toBeInstanceOf(
          GatewayOperatorAccessDeniedError,
        );
        requiresGitHub = false;
        clock.mockReturnValue(NOW + DAY_MS);
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toBeInstanceOf(
          GatewayOperatorAccessDeniedError,
        );
        await visitor.service.invite({ email: grant.email, days: 1 }, visitor.authority);
        expect(
          (await resolveAuthenticatedHttpUserProfile(request)).authenticatedUserProfile?.profileId,
        ).toBe(profileId);
        await visitor.service.revoke({ email: grant.email }, visitor.authority.assertCurrent);
        await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toBeInstanceOf(
          GatewayOperatorAccessDeniedError,
        );
        expect(getUserProfileListItem(profileId).githubIdentity).toBeNull();
      } finally {
        catalog.release();
        request.req.destroy();
      }
    });
  });

  it("admits a pending numeric-only invitation through HTTP and WebSocket and rejects unverified or expired access", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const principal = "ada@example.test";
      const unverifiedPrincipal = "unverified@example.test";
      const invitedCfg: OpenClawConfig = {
        gateway: {
          ...githubCfg.gateway,
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://gateway.example.test"] },
          auth: {
            ...githubCfg.gateway?.auth,
            identityScopes: { [principal]: ["operator.sessions.write"] },
            trustedProxy: {
              ...githubCfg.gateway?.auth?.trustedProxy,
              userHeader: "cf-access-authenticated-user-email",
              allowLoopback: true,
            },
          },
          roles: { default: "guest", definitions: { guest: guestRole } },
        },
      };
      const visitor = visitorFixture({ gatewayConfig: invitedCfg, githubEmail: null });
      await visitor.service.initialize();
      const { config, registry } = createPluginRegistryFixture();
      registerVirtualTestPlugin({
        registry,
        config,
        id: "visitor-access",
        name: "Visitor access",
        register(api) {
          api.registerGatewayAccessPolicy({
            authorize({ profile, requiredByRole }) {
              return requiredByRole
                ? visitor.service.authorize(profile.emails, profile.githubAccountIds)
                : undefined;
            },
          });
        },
      });
      setActivePluginRegistry(registry.registry);
      let identity = oidcIdentity("42", "custom");
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href === `${accessOrigin}/cdn-cgi/access/get-identity`) {
          return identityResponse(identity);
        }
        expect(url.href).toBe("https://api.github.com/user/42");
        return identityResponse({
          id: 42,
          login: "canonical-ada",
          email: "public-email-is-not-the-login@example.test",
        });
      });
      const createRequest = (email: string) => {
        const request = accessRequest(email, invitedCfg);
        const headers = {
          host: "gateway.example.test",
          origin: "https://gateway.example.test",
          "x-forwarded-for": "203.0.113.42",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "gateway.example.test",
          "cf-access-authenticated-user-email": email,
          "cf-access-jwt-assertion": String(request.req.headers["cf-access-jwt-assertion"]),
        };
        request.req.headers = headers;
        Object.defineProperty(request.req.socket, "remoteAddress", { value: "127.0.0.1" });
        return { ...request, headers };
      };
      const request = createRequest(principal);
      const unverifiedRequest = createRequest(unverifiedPrincipal);
      const auth = resolveGatewayAuth({ authConfig: invitedCfg.gateway?.auth, env: {} });
      const httpAdmission = (candidate: ReturnType<typeof createRequest>) =>
        checkGatewayHttpRequestAuth({
          req: candidate.req,
          cfg: invitedCfg,
          auth,
          trustedProxies: invitedCfg.gateway?.trustedProxies,
        });
      const websocketAdmission = async (candidate: ReturnType<typeof createRequest>) => {
        const response = createDeferred<unknown>();
        const connectionWork = new GatewayConnectionWork();
        let closed = false;
        const socket = createGatewayWsTestSocket({
          closeEmits: true,
          onSend(data) {
            const frame: unknown = JSON.parse(data);
            if (isRecord(frame) && frame.type === "res" && frame.id === "visitor-connect") {
              response.resolve(frame);
            }
          },
        });
        socket.once("close", (code, reason) => {
          closed = true;
          response.reject(
            new Error(`Visitor connection closed before response: ${code} ${reason}`),
          );
        });
        try {
          const connection = attachGatewayWsForTest({
            attach: attachGatewayWsConnectionHandler,
            socket,
            headers: candidate.headers,
            trustedProxies: invitedCfg.gateway?.trustedProxies,
            options: { connectionWork, getResolvedAuth: () => auth },
          });
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                type: "req",
                id: "visitor-connect",
                method: "connect",
                params: {
                  minProtocol: PROTOCOL_VERSION,
                  maxProtocol: PROTOCOL_VERSION,
                  client: {
                    id: "openclaw-control-ui",
                    version: "dev",
                    buildId: "dev",
                    platform: "web",
                    mode: "webchat",
                  },
                  role: "operator",
                  scopes: ["operator.admin", "operator.sessions.write"],
                },
              }),
            ),
          );
          const frame = await withinTest(response.promise, signal);
          return { frame, clients: [...connection.clients] };
        } finally {
          if (!closed) {
            socket.emit("close", 1000, Buffer.from("fixture cleanup"));
          }
          await connectionWork.drain();
        }
      };
      const expectDenied = async (candidate: ReturnType<typeof createRequest>) => {
        await expect(httpAdmission(candidate)).resolves.toMatchObject({
          ok: false,
          authResult: { reason: "operator_access_denied" },
        });
        expect(await websocketAdmission(candidate)).toMatchObject({
          frame: {
            ok: false,
            error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
          },
          clients: [],
        });
      };
      const catalog = await prepareUserProfileCatalog();
      try {
        const invitation = await visitor.service.invite(
          { github: "canonical-ada", days: 1 },
          visitor.authority,
        );
        expect(invitation.details).toMatchObject({ githubAccountId: 42 });
        expect(invitation.details).not.toHaveProperty("email");
        expect(invitation.details.gatewayAccess).toContain("first sign-in pending");
        expect([...visitor.grants.keys()]).toEqual(["github:42"]);
        expect(visitor.targets()).toEqual([42]);
        expect(visitor.emails()).toEqual([]);
        expect(transport).not.toHaveBeenCalled();

        const admitted = await httpAdmission(request);
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) {
          throw new Error(`Numeric HTTP admission failed: ${admitted.authResult.reason}`);
        }
        const profileId = admitted.requestAuth.authenticatedUserProfile?.profileId;
        if (!profileId) {
          throw new Error("Numeric HTTP admission did not create a canonical profile");
        }
        expect(admitted.requestAuth.authMethod).toBe("trusted-proxy");
        expect(admitted.requestAuth.operatorRolePolicy?.scopes).toEqual(guestRole.scopes);
        expect(admitted.requestAuth.operatorAccessAuthority?.gatewayAccessGrant).toEqual({
          pluginId: "visitor-access",
          grantId: invitation.details.grantId,
        });
        expect(admitted.requestAuth.hasCurrentClientAuthority()).toBe(true);
        expect(getUserProfileListItem(profileId)).toMatchObject({
          emails: [principal],
          githubIdentity: { login: "canonical-ada" },
        });
        expect((await resolveUserProfileGitHubAttribution([profileId])).get(profileId)).toEqual({
          accountId: 42,
          login: "canonical-ada",
        });
        expect(await websocketAdmission(request)).toMatchObject({
          frame: {
            ok: true,
            payload: {
              type: "hello-ok",
              auth: { method: "trusted-proxy", role: "operator", scopes: guestRole.scopes },
            },
          },
          clients: [
            {
              authenticatedUserProfile: { profileId },
              internal: {
                operatorAccessAuthority: {
                  gatewayAccessGrant: {
                    pluginId: "visitor-access",
                    grantId: invitation.details.grantId,
                  },
                },
              },
            },
          ],
        });

        identity = { ...oidcIdentity("042", "custom"), email: unverifiedPrincipal };
        await expectDenied(unverifiedRequest);

        identity = oidcIdentity("42", "custom");
        clock.mockReturnValue(NOW + DAY_MS);
        await expectDenied(request);
        expect(admitted.requestAuth.hasCurrentClientAuthority()).toBe(false);
        expect([...visitor.grants.keys()]).toEqual(["github:42"]);
        expect(visitor.emails()).toEqual([]);
      } finally {
        visitor.service.close();
        catalog.release();
        request.req.destroy();
        unverifiedRequest.req.destroy();
      }
    });
  });
});
