import { expectDefined } from "@openclaw/normalization-core";
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { registerWebPushSubscription } from "../../infra/push-web.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import {
  readResidentUserProfileIdentity,
  readResidentUserProfileId,
} from "../../state/user-profile-list.js";
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
// Keep the dispatcher's cold runtime import outside timed authority cases.
import "../server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { pushHandlers } from "./push.js";
import { holdPushStorage, pushClient, pushSubscription } from "./push.test-support.js";

// mock-isolation: Keep APNs registration and delivery outside the router-authority fixture.
vi.mock("../../infra/push-apns.js", async () =>
  (await import("./push.test-support.js")).mockPushApns(),
);
// mock-isolation: The suite controls Web Push storage admission without external delivery.
vi.mock("../../infra/push-web.js", async () =>
  (await import("./push.test-support.js")).mockPushWeb(),
);
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  readResidentUserProfileId: vi.fn(),
  readResidentUserProfileIdentity: vi.fn(),
}));
vi.mock("../../state/user-channel-identity-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-channel-identity-operations.js")>()),
  prepareUserProfileSelectionAuthority: vi.fn(),
}));
vi.mock("../../state/user-preferences.js", () => ({
  getCanonicalUserPreferences: vi.fn(),
  setCanonicalUserPreferences: vi.fn(),
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

it.each([
  "merged alias",
  "transport retirement",
  "retained device revoked",
  "Gateway closed",
  "worker selection mismatch",
] as const)(
  "Web Push router keeps profile SQL outside the worker grant for %s",
  async (scenario) => {
    let inGrant = false;
    const forbiddenGrantReads = vi.fn();
    const selectProfile = (profileId: string) => {
      if (inGrant) {
        forbiddenGrantReads();
        throw new Error("profile lookup attempted during worker admission");
      }
      return profileId === "retired-profile" ? "profile-owner" : profileId;
    };
    vi.mocked(prepareUserProfileSelectionAuthority).mockImplementation(async (profileId) => ({
      profileId: selectProfile(profileId),
      isCurrent: () => true,
    }));
    vi.mocked(readResidentUserProfileId).mockImplementation(selectProfile);
    vi.mocked(readResidentUserProfileIdentity).mockImplementation((profileId) => ({
      profileId: selectProfile(profileId),
      role: null,
      aliases: new Set([profileId]),
    }));
    const storage = holdPushStorage();
    const persisted = vi.fn();
    vi.mocked(registerWebPushSubscription).mockImplementation(async (params) => {
      await storage.wait();
      inGrant = true;
      try {
        const guard = expectDefined(params.guard, "worker grant authority");
        assert(guard.family === "worker", "WebSocket request lost its worker authority");
        guard.assertCurrent();
        guard.assertProfiles({
          profileId: scenario === "worker selection mismatch" ? "other-profile" : "profile-owner",
          bindingCurrent: true,
        });
        persisted();
      } finally {
        inGrant = false;
      }
      return pushSubscription(params.endpoint, params.keys, "router-subscription");
    });
    const connection = new AbortController();
    const clientProfile = pushClient(
      scenario === "merged alias" ? "retired-profile" : "profile-owner",
      "original-connection",
      connection.signal,
    );
    const client: GatewayWsClient = {
      ...createOperatorWsClient(),
      ...clientProfile,
      authenticatedUserProfile: {
        ...expectDefined(clientProfile.authenticatedUserProfile, "bound profile"),
        avatarRevision: "1",
      },
    };
    const isConnectionActive = vi.fn(() => true);
    const getClientConnIds = vi.fn(() => new Set(["original-connection"]));
    setRuntimeConfigSnapshot({});
    const context = createDirectChatContext({ isConnectionActive, getClientConnIds });
    onTestFinished(() => {
      closeGatewayDeviceRevocation(context);
      clearRuntimeConfigSnapshot();
    });
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
    await storage.settle(request, () => {
      expect(prepareUserProfileSelectionAuthority).toHaveBeenCalledWith(
        client.authenticatedUserProfile?.profileId,
      );
      expect(readResidentUserProfileId).not.toHaveBeenCalled();
      expect(persisted).not.toHaveBeenCalled();
      if (scenario === "transport retirement" || scenario === "retained device revoked") {
        connection.abort();
        isConnectionActive.mockReturnValue(false);
        getClientConnIds.mockReturnValue(new Set());
      }
      if (scenario === "retained device revoked") {
        invalidateGatewayDeviceRevocation(context, "browser-device", "operator");
        expect(client.invalidated).not.toBe(true);
      } else if (scenario === "Gateway closed") {
        closeGatewayDeviceRevocation(context);
        expect(client.invalidated).not.toBe(true);
      }
    });
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
  },
);
