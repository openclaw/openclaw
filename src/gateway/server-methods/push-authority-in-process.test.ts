import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerWebPushSubscription } from "../../infra/push-web.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { dispatchGatewayMethodInProcessRaw } from "../server-plugin-in-process-dispatch.js";
import { pushHandlers } from "./push.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

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
vi.mock("../../state/user-preferences.js", () => ({
  getUserPreferences: vi.fn(),
  setUserPreferences: vi.fn(),
}));
vi.mock("../session-sharing.js", async () => ({
  // The real Web Push handler has no session target; leave its request guards intact.
  resolveSessionMutationAuthorization: vi.fn(() => ({ error: null })),
  SessionMutationAuthorizationChangedError: (
    await import("../session-mutation-authorization-error.js")
  ).SessionMutationAuthorizationChangedError,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetGatewayWorkAdmission();
  vi.mocked(resolveUserProfileId).mockImplementation((profileId) => profileId);
});

describe("Web Push opaque in-process authority", () => {
  it.each(["unchanged", "resolver retired", "caller revoked", "transport retirement"] as const)(
    "retains the full native commit guard for %s",
    async (scenario) => {
      const entered = createDeferred();
      const release = createDeferred();
      const persisted = vi.fn();
      const resolverCommitChecks = vi.fn();
      const callerCommitChecks = vi.fn();
      const work = new AsyncWorkScope();
      let inNativeCommit = false;
      let observedFamily: string | undefined;
      vi.mocked(registerWebPushSubscription).mockImplementation(async (params) => {
        const guard = expectDefined(params.guard, "retained Web Push mutation guard");
        observedFamily = guard.family;
        entered.resolve();
        await release.promise;
        inNativeCommit = true;
        try {
          if (guard.family === "worker") {
            guard.assertProfiles({ profileId: "profile-owner", bindingCurrent: true });
          }
          guard.assertCurrent();
          persisted();
        } finally {
          inNativeCommit = false;
        }
        return {
          subscriptionId: "in-process-subscription",
          endpoint: params.endpoint,
          keys: params.keys,
          createdAtMs: 1,
          updatedAtMs: 1,
        };
      });

      const connection = new AbortController();
      const connectionId = "paired-in-process-client";
      const client: GatewayClient = {
        connId: connectionId,
        connectionSignal: connection.signal,
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
          role: "operator",
          scopes: ["operator.write"],
          device: {
            id: "paired-browser",
            publicKey: "synthetic-public-key",
            signature: "synthetic-signature",
            signedAt: 1,
            nonce: "synthetic-nonce",
          },
        },
        authenticatedUserProfile: {
          profileId: "profile-owner",
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const registry = createRequestGatewayMethodRegistry(pushHandlers);
      const isConnectionActive = vi.fn(() => true);
      const getClientConnIds = vi.fn(() => new Set([connectionId]));
      const context = createDirectChatContext({
        getGatewayMethodRegistry: () => registry,
        trackExecution: (run) => work.track(run),
        isConnectionActive,
        getClientConnIds,
      });
      let liveContext: GatewayRequestContext | undefined = context;
      let callerAllowed = true;
      const resolveGatewayContext = () => {
        if (inNativeCommit) {
          resolverCommitChecks();
        }
        return liveContext;
      };
      const assertCallerCurrent = () => {
        if (inNativeCommit) {
          callerCommitChecks();
        }
        if (!callerAllowed) {
          throw new Error("opaque caller authority revoked");
        }
      };
      const request = withPluginRuntimeGatewayRequestScope(
        { context, client, resolveGatewayContext, isWebchatConnect: () => true },
        () =>
          dispatchGatewayMethodInProcessRaw(
            "push.web.subscribe",
            {
              endpoint: "https://push.example.test/in-process-authority",
              keys: { p256dh: "synthetic-p256dh", auth: "synthetic-auth" },
            },
            {
              resolveGatewayContext,
              sessionMutationCommitGuard: assertCallerCurrent,
            },
          ),
      );
      try {
        await Promise.race([
          entered.promise,
          request.then(() => {
            throw new Error("in-process dispatch returned before storage admission");
          }),
        ]);
        expect(persisted).not.toHaveBeenCalled();
        if (scenario === "resolver retired") {
          liveContext = undefined;
        } else if (scenario === "caller revoked") {
          callerAllowed = false;
        } else if (scenario === "transport retirement") {
          connection.abort();
          isConnectionActive.mockReturnValue(false);
          getClientConnIds.mockReturnValue(new Set());
        }
      } finally {
        release.resolve();
        try {
          await request;
        } finally {
          await work.drain();
        }
      }
      const result = await request;
      if (scenario === "resolver retired" || scenario === "caller revoked") {
        expect(persisted).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      } else {
        expect(persisted).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
          ok: true,
          payload: { subscriptionId: "in-process-subscription" },
        });
      }
      expect(observedFamily).toBe("native-compatibility");
      expect(resolverCommitChecks).toHaveBeenCalled();
      if (scenario !== "resolver retired") {
        expect(callerCommitChecks).toHaveBeenCalled();
      }
    },
  );
});
