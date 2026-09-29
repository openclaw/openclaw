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
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  accessOrigin,
  accessRequest,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "../../src/gateway/github-user-identity.oidc.test-support.js";
import { resolveAuthenticatedHttpUserProfile } from "../../src/gateway/http-auth-user-profile.js";
import { GatewayOperatorAccessDeniedError } from "../../src/gateway/operator-access-policy.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { resolveUserProfileGitHubAttribution } from "../../src/state/user-profile-github-identity.js";
import { getUserProfileListItem } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  closeVisitorFixtures();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Cloudflare OIDC and Visitor Access admission", () => {
  it("admits a new invited email during an outage while enforcing current access requirements", async () => {
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
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
        url === `${accessOrigin}/cdn-cgi/access/get-identity`
          ? identityResponse(oidcIdentity("101", "custom"))
          : identityResponse({}, 503),
      );
      const request = accessRequest(grant.email, invitedCfg);
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

        requiresGitHub = true;
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
        request.req.destroy();
      }
    });
  });
});
