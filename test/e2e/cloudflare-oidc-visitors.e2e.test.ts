import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, it, vi } from "vitest";
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
import { getUserProfileListItem } from "../../src/state/user-profile-list-item.test-support.js";
import { prepareUserProfileCatalog } from "../../src/state/user-profile-list.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createDeferred, withinTest } from "../helpers/promise.js";

const principal = "ada@example.test";
const unverifiedPrincipal = "unverified@example.test";
const cfg: OpenClawConfig = {
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
const connectFrame = Buffer.from(
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
);

function createRequest(email: string) {
  const request = accessRequest(email, cfg);
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
}

async function websocketAdmission(
  candidate: ReturnType<typeof createRequest>,
  signal: AbortSignal,
) {
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
    response.reject(new Error(`Visitor connection closed before response: ${code} ${reason}`));
  });
  try {
    const connection = attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      socket,
      headers: candidate.headers,
      trustedProxies: cfg.gateway?.trustedProxies,
      options: {
        connectionWork,
        getResolvedAuth: () => resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: {} }),
      },
    });
    socket.emit("message", connectFrame);
    return { frame: await withinTest(response.promise, signal), clients: [...connection.clients] };
  } finally {
    if (!closed) {
      socket.emit("close", 1000, Buffer.from("fixture cleanup"));
    }
    await connectionWork.drain();
  }
}

afterEach(async () => {
  closeVisitorFixtures();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.for(["email", "github"] as const)(
  "enforces current %s invitations without changing canonical identity",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const numeric = kind === "github";
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const grant = visitorGrant(principal);
      const visitor = visitorFixture({
        gatewayConfig: cfg,
        ...(numeric ? {} : { grants: [grant], emails: [principal] }),
      });
      await visitor.service.initialize();
      let requiresGitHub = false;
      const { config, registry } = createPluginRegistryFixture();
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
              return visitor.service.authorize(
                profile.emails,
                numeric ? profile.githubAccountIds : undefined,
              );
            },
          });
        },
      });
      setActivePluginRegistry(registry.registry);
      let identity = oidcIdentity(numeric ? "42" : "01", "custom");
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href === `${accessOrigin}/cdn-cgi/access/get-identity`) {
          return identityResponse(identity);
        }
        if (!numeric) {
          return identityResponse({}, 503);
        }
        expect(url.href).toBe("https://api.github.com/user/42");
        return identityResponse({
          id: 42,
          login: "canonical-ada",
          email: "public-email-is-not-the-login@example.test",
        });
      });
      const request = createRequest(principal);
      const unverified = createRequest(unverifiedPrincipal);
      const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: {} });
      const httpAdmission = (candidate = request) =>
        checkGatewayHttpRequestAuth({
          req: candidate.req,
          cfg,
          auth,
          trustedProxies: cfg.gateway?.trustedProxies,
        });
      const deny = async (candidate = request) => {
        if (!numeric) {
          await expect(resolveAuthenticatedHttpUserProfile(candidate)).rejects.toBeInstanceOf(
            GatewayOperatorAccessDeniedError,
          );
          return;
        }
        await expect(httpAdmission(candidate)).resolves.toMatchObject({
          ok: false,
          authResult: { reason: "operator_access_denied" },
        });
        expect(await websocketAdmission(candidate, signal)).toMatchObject({
          frame: {
            ok: false,
            error: { code: "FORBIDDEN", details: { code: "OPERATOR_ACCESS_DENIED" } },
          },
          clients: [],
        });
      };
      const catalog = await prepareUserProfileCatalog();
      try {
        const invitation = numeric
          ? await visitor.service.invite({ github: "canonical-ada", days: 1 }, visitor.authority)
          : undefined;
        if (invitation) {
          expect(invitation.details).toMatchObject({
            githubAccountId: 42,
            gatewayAccess: expect.stringContaining("first sign-in pending"),
          });
          expect(invitation.details).not.toHaveProperty("email");
          expect([...visitor.grants.keys()]).toEqual(["github:42"]);
          expect(visitor.targets()).toEqual([42]);
          expect(visitor.emails()).toEqual([]);
          expect(transport).not.toHaveBeenCalled();
        }
        const admitted = await httpAdmission();
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) {
          throw new Error(`HTTP admission failed: ${admitted.authResult.reason}`);
        }
        const profile = admitted.requestAuth;
        const profileId = profile.authenticatedUserProfile?.profileId;
        if (!profileId) {
          throw new Error("HTTP admission did not create a canonical profile");
        }
        expect(profile).toMatchObject({
          authMethod: "trusted-proxy",
          operatorRolePolicy: { scopes: guestRole.scopes },
        });
        expect(profile.operatorAccessAuthority).toBeTruthy();
        expect(profile.hasCurrentClientAuthority()).toBe(true);
        expect(getUserProfileListItem(profileId)).toMatchObject({
          emails: [principal],
          githubIdentity: numeric ? { login: "canonical-ada" } : null,
        });
        expect((await resolveUserProfileGitHubAttribution([profileId])).get(profileId)).toEqual(
          numeric ? { accountId: 42, login: "canonical-ada" } : null,
        );
        if (invitation) {
          const gatewayAccessGrant = {
            pluginId: "visitor-access",
            grantId: invitation.details.grantId,
          };
          expect(profile.operatorAccessAuthority?.gatewayAccessGrant).toEqual(gatewayAccessGrant);
          expect(await websocketAdmission(request, signal)).toMatchObject({
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
                internal: { operatorAccessAuthority: { gatewayAccessGrant } },
              },
            ],
          });
          identity = { ...oidcIdentity("042", "custom"), email: unverifiedPrincipal };
          await deny(unverified);
          identity = oidcIdentity("42", "custom");
        } else {
          expect(transport).toHaveBeenCalledOnce();
          requiresGitHub = true;
          await deny();
          identity = oidcIdentity("101", "custom");
          await deny();
          requiresGitHub = false;
        }
        clock.mockReturnValue(NOW + DAY_MS);
        await deny();
        expect(profile.hasCurrentClientAuthority()).toBe(false);
        if (numeric) {
          expect([...visitor.grants.keys()]).toEqual(["github:42"]);
          expect(visitor.emails()).toEqual([]);
        } else {
          await visitor.service.invite({ email: principal, days: 1 }, visitor.authority);
          expect(
            (await resolveAuthenticatedHttpUserProfile(request)).authenticatedUserProfile
              ?.profileId,
          ).toBe(profileId);
          await visitor.service.revoke({ email: principal }, visitor.authority.assertCurrent);
          await deny();
          expect(getUserProfileListItem(profileId).githubIdentity).toBeNull();
        }
      } finally {
        visitor.service.close();
        catalog.release();
        request.req.destroy();
        unverified.req.destroy();
      }
    });
  },
);
