import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { syncGitHubIdentity } from "../../../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { withTempConfig } from "../../test-temp-config.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createOperatorWsClient } from "./authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./connect-operator-access.js";
import { createGatewayConnectProfileLifecycle } from "./connect-user-profile.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const cfg: OpenClawConfig = {
  gateway: { auth: { mode: "token", token: "synthetic-gateway-token", allowTailscale: true } },
};

function createLifecycle(client: GatewayWsClient) {
  const handler = {
    connId: client.connId,
    socket: { readyState: WEBSOCKET_OPEN_READY_STATE },
    connectionWork: new AbortController(),
    isClosed: () => false,
    getClient: () => client,
    buildRequestContext: () => ({}),
    setCloseCause: vi.fn(),
    close: vi.fn(),
  };
  const context = { configSnapshot: cfg, handler } as unknown as GatewayConnectPhaseContext;
  const state = { role: "operator" } as DeviceAuthorizedGatewayConnect;
  const lifecycle = createGatewayConnectProfileLifecycle(context, state);
  lifecycle.bind(client);
  return lifecycle;
}

const prepareIngress = (profile: { profileId: string; displayName?: string | null }) =>
  prepareGatewayLocalUserIngress({
    authMethod: "tailscale",
    authenticatedUserExpected: true,
    profile,
    isLocalClient: true,
  });

it("prepares operator access when a deferred GitHub profile attaches after connect", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await withTempConfig({
      cfg,
      run: async () => {
        const profile = syncGitHubIdentity({
          identity: { accountId: 9001, login: "bob" },
          authenticationAlias: { kind: "github-login", login: "bob" },
        });
        // Connect admission defers the profile without roles or access policies.
        const client = createOperatorWsClient({ connId: "deferred-profile" });
        prepareGatewayConnectOperatorAccess(client);
        expect(client.internal?.operatorAccessAuthority).toBeUndefined();

        await createLifecycle(client).attach(profile.id, profile.updatedAt, prepareIngress);

        expect(client.authenticatedUserProfile?.profileId).toBe(profile.id);
        // Null is the explicit "no access policy" grant that run authority and
        // GitHub publication require; undefined made publication reject the requester.
        expect(client.internal?.operatorAccessAuthority).toBeNull();
      },
    });
  });
});

it("keeps operator access prepared at connect when a profile refresh attaches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await withTempConfig({
      cfg,
      run: async () => {
        const profile = syncGitHubIdentity({
          identity: { accountId: 9001, login: "bob" },
          authenticationAlias: { kind: "github-login", login: "bob" },
        });
        const client = createOperatorWsClient({ connId: "eager-profile" });
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: "bob",
          avatarRevision: "",
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        prepareGatewayConnectOperatorAccess(client);
        const internal = client.internal;
        expect(internal?.operatorAccessAuthority).toBeNull();

        await createLifecycle(client).attach(profile.id, profile.updatedAt, prepareIngress);

        expect(client.internal).toBe(internal);
      },
    });
  });
});
