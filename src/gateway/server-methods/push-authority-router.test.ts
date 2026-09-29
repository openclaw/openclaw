import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerWebPushSubscription } from "../../infra/push-web.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import { readUserProfileIdentity } from "../../state/user-profile-list.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import {
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { pushHandlers } from "./push.js";

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(),
}));
vi.mock("../../infra/push-web.js", () => ({
  WebPushSubscriptionBindingError: class extends Error {},
  broadcastWebPush: vi.fn(),
  clearBoundWebPushSubscription: vi.fn(),
  withBoundWebPushSubscriptionByEndpoint: vi.fn(),
  registerWebPushSubscription: vi.fn(),
  resolveVapidKeys: vi.fn(),
  setWebPushSubscriptionPreferences: vi.fn(),
}));
vi.mock("../../state/user-profiles.js", () => ({ resolveUserProfileId: vi.fn() }));
vi.mock("../../state/user-profile-list.js", () => ({ readUserProfileIdentity: vi.fn() }));
vi.mock("../../state/user-channel-identity-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-channel-identity-operations.js")>()),
  prepareUserProfileSelectionAuthority: vi.fn(),
}));
vi.mock("../../state/user-preferences.js", () => ({
  getUserPreferences: vi.fn(),
  setUserPreferences: vi.fn(),
}));
vi.mock("../session-sharing.js", async () => ({
  // Web Push has no session target; keep unrelated session storage outside this router control.
  resolveSessionMutationAuthorization: vi.fn(() => ({ error: null })),
  SessionMutationAuthorizationChangedError: (
    await import("../session-mutation-authorization-error.js")
  ).SessionMutationAuthorizationChangedError,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetGatewayWorkAdmission();
});

describe("Web Push router authority at the worker grant", () => {
  it.each([
    "unchanged",
    "merged alias",
    "transport retirement",
    "retained device revoked",
    "Gateway closed",
    "worker selection mismatch",
  ] as const)("keeps profile SQL outside the grant for %s", async (scenario) => {
    let inGrant = false;
    const forbiddenGrantReads = vi.fn();
    vi.mocked(prepareUserProfileSelectionAuthority).mockImplementation(async (profileId) => {
      if (inGrant) {
        forbiddenGrantReads();
        throw new Error("profile authority acquisition attempted during worker admission");
      }
      return {
        profileId: profileId === "retired-profile" ? "profile-owner" : profileId,
        isCurrent: () => true,
      };
    });
    vi.mocked(resolveUserProfileId).mockImplementation((profileId) => {
      if (inGrant) {
        forbiddenGrantReads();
        throw new Error("profile SQL attempted while the worker owns its transaction");
      }
      return profileId === "retired-profile" ? "profile-owner" : profileId;
    });
    vi.mocked(readUserProfileIdentity).mockImplementation((profileId) => {
      if (inGrant) {
        forbiddenGrantReads();
        throw new Error("profile catalog acquisition attempted during worker admission");
      }
      return {
        profileId: profileId === "retired-profile" ? "profile-owner" : profileId,
        role: null,
        aliases: new Set([profileId]),
      };
    });
    const entered = createDeferred();
    const release = createDeferred();
    const persisted = vi.fn();
    vi.mocked(registerWebPushSubscription).mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      inGrant = true;
      try {
        const guard = expectDefined(params.guard, "worker grant authority");
        expect(guard.family).toBe("worker");
        if (guard.family !== "worker") {
          throw new Error("WebSocket request lost its worker authority");
        }
        guard.assertCurrent();
        guard.assertProfiles({
          profileId: scenario === "worker selection mismatch" ? "other-profile" : "profile-owner",
          bindingCurrent: true,
        });
        persisted();
      } finally {
        inGrant = false;
      }
      return {
        subscriptionId: "router-subscription",
        endpoint: params.endpoint,
        keys: params.keys,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
    });
    const connection = new AbortController();
    const client: GatewayWsClient = {
      ...createOperatorWsClient(),
      connId: "original-connection",
      connect: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        role: "operator",
        scopes: ["operator.write"],
        device: {
          id: "browser-device",
          publicKey: "synthetic-public-key",
          signature: "synthetic-signature",
          signedAt: 1,
          nonce: "synthetic-nonce",
        },
      },
      authenticatedUserProfile: {
        profileId: scenario === "merged alias" ? "retired-profile" : "profile-owner",
        displayName: null,
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      },
      connectionSignal: connection.signal,
    };
    const isConnectionActive = vi.fn(() => true);
    const getClientConnIds = vi.fn(() => new Set(["original-connection"]));
    const context = createDirectChatContext({ isConnectionActive, getClientConnIds });
    const harness = createDispatchTestHarness({
      connId: "original-connection",
      getRequiredSharedGatewaySessionGeneration: new SharedGatewaySessionGenerationState({
        current: "generation-a",
        required: null,
      }).reader,
      buildRequestContext: () => context,
      extraHandlers: pushHandlers,
    });
    const request = harness.dispatcher.dispatch(
      {
        type: "req",
        id: "router-authority",
        method: "push.web.subscribe",
        expectedProfileId: "profile-owner",
        params: {
          endpoint: "https://push.example.test/router-authority",
          keys: { p256dh: "synthetic-p256dh", auth: "synthetic-auth" },
        },
      },
      client,
    );
    try {
      await Promise.race([
        entered.promise,
        request.then(() => {
          throw new Error("router returned before storage admission");
        }),
      ]);
      expect(prepareUserProfileSelectionAuthority).toHaveBeenCalledWith(
        client.authenticatedUserProfile?.profileId,
      );
      expect(resolveUserProfileId).toHaveBeenCalled();
      expect(persisted).not.toHaveBeenCalled();
      if (scenario === "transport retirement") {
        connection.abort();
        isConnectionActive.mockReturnValue(false);
        getClientConnIds.mockReturnValue(new Set());
      } else if (scenario === "retained device revoked") {
        connection.abort();
        isConnectionActive.mockReturnValue(false);
        getClientConnIds.mockReturnValue(new Set());
        invalidateGatewayDeviceRevocation(context, "browser-device", "operator");
        expect(client.invalidated).not.toBe(true);
      } else if (scenario === "Gateway closed") {
        closeGatewayDeviceRevocation(context);
        expect(client.invalidated).not.toBe(true);
      }
    } finally {
      release.resolve();
      await request;
    }
    expect(forbiddenGrantReads).not.toHaveBeenCalled();
    if (scenario === "retained device revoked" || scenario === "Gateway closed") {
      expect(persisted).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
      return;
    }
    expect(harness.send).toHaveBeenCalledOnce();
    const response = await harness.awaitResponseFrame("router-authority");
    if (scenario === "worker selection mismatch") {
      expect(persisted).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
        },
      });
      return;
    }
    expect(persisted).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      ok: true,
      payload: { subscriptionId: "router-subscription" },
    });
  });
});
