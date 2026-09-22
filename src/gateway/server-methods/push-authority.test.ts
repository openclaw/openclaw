import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WebPushMutationGuard } from "../../infra/push-web-store.records.js";
import {
  clearBoundWebPushSubscription,
  registerWebPushSubscription,
  setWebPushSubscriptionPreferences,
  type BoundWebPushSubscription,
} from "../../infra/push-web.js";
import { setUserPreferences } from "../../state/user-preferences.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { pushHandlers } from "./push.js";
import type { GatewayClient } from "./types.js";

const { findBoundWebPushSubscriptionByEndpoint, snapshotScope } = vi.hoisted(() => ({
  findBoundWebPushSubscriptionByEndpoint:
    vi.fn<(params: { endpoint: string }) => Promise<BoundWebPushSubscription | null>>(),
  snapshotScope: { active: false },
}));

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
  withBoundWebPushSubscriptionByEndpoint: async <T>(
    params: { endpoint: string },
    prepare: (subscription: BoundWebPushSubscription | null) => { start: () => T } | undefined,
  ) => {
    const snapshotSubscription = await findBoundWebPushSubscriptionByEndpoint(params);
    const action = prepare(snapshotSubscription);
    snapshotScope.active = true;
    try {
      return action?.start();
    } finally {
      snapshotScope.active = false;
    }
  },
  registerWebPushSubscription: vi.fn(),
  resolveVapidKeys: vi.fn(),
  setWebPushSubscriptionPreferences: vi.fn(),
}));
vi.mock("../../state/user-preferences.js", () => ({
  getUserPreferences: vi.fn(() => ({})),
  setUserPreferences: vi.fn(),
}));
vi.mock("../../state/user-profiles.js", () => ({ resolveUserProfileId: vi.fn() }));

const endpoint = "https://push.example.test/authority";
const keys = { p256dh: "synthetic-p256dh", auth: "synthetic-auth" };
type WriteMethod = "push.web.subscribe" | "push.web.preferences.set" | "push.web.unsubscribe";

function subscription(userProfileId: string | null = "profile-owner"): BoundWebPushSubscription {
  return {
    subscriptionId: "subscription-owner",
    endpoint,
    keys,
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: "browser-device",
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

function createInvocation(method: WriteMethod, scope: "user" | "device" = "device") {
  const transport = new AbortController();
  const request = new AbortController();
  const client: GatewayClient = {
    connId: "original-connection",
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      device: {
        id: "browser-device",
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
    connectionSignal: transport.signal,
  };
  const respond = vi.fn();
  const broadcast = vi.fn();
  const hasCurrentClientAuthority = vi.fn(() => true);
  const sessionMutationCommitGuard = vi.fn();
  const options: Parameters<(typeof pushHandlers)["push.web.preferences.set"]>[0] = {
    req: { type: "req", id: "authority-request", method },
    params: {
      endpoint,
      ...(method === "push.web.subscribe" ? { keys } : {}),
      ...(method === "push.web.preferences.set"
        ? {
            scope,
            preferences:
              scope === "device"
                ? { enabled: true, label: "Browser" }
                : {
                    categories: {
                      approvalRequested: true,
                      agentFinished: true,
                      agentQuestion: true,
                      humanMentioned: true,
                      scheduledTaskFailed: true,
                      backgroundTaskFailed: true,
                    },
                    detailLevel: "private",
                    quietHours: { enabled: false, startMinute: 0, endMinute: 0, timeZone: "UTC" },
                    agentIds: [],
                  },
          }
        : {}),
    },
    client,
    respond,
    context: {
      getRuntimeConfig: () => ({}),
      getClientConnIds: () => new Set(["current-connection"]),
      broadcastToConnIds: broadcast,
    },
    isWebchatConnect: () => false,
    signal: request.signal,
    hasCurrentClientAuthority,
    sessionMutationCommitGuard,
  };
  return {
    client,
    request,
    respond,
    broadcast,
    hasCurrentClientAuthority,
    sessionMutationCommitGuard,
    reconnect() {
      transport.abort();
    },
    invoke: () => Promise.resolve(expectDefined(pushHandlers[method], "Web Push handler")(options)),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  snapshotScope.active = false;
  vi.mocked(resolveUserProfileId).mockImplementation((id) => id);
  vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(subscription());
  vi.mocked(registerWebPushSubscription).mockResolvedValue(subscription());
  vi.mocked(setWebPushSubscriptionPreferences).mockResolvedValue(true);
  vi.mocked(clearBoundWebPushSubscription).mockResolvedValue(true);
  vi.mocked(setUserPreferences).mockReturnValue({ ok: true, value: undefined });
});

describe("Web Push request authority across asynchronous storage", () => {
  it("writes user preferences during the owned subscription start", async () => {
    vi.mocked(setUserPreferences).mockImplementation(() => {
      expect(snapshotScope.active).toBe(true);
      return { ok: true, value: undefined };
    });
    const invocation = createInvocation("push.web.preferences.set", "user");
    await invocation.invoke();
    expect(setUserPreferences).toHaveBeenCalledOnce();
    expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
    expect(snapshotScope.active).toBe(false);
  });

  it.each([
    "invalidated client",
    "request abort",
    "scope downgrade",
    "profile switch",
    "session guard revoked",
    "caller authority revoked",
    "reconnect only",
  ] as const)("rechecks %s after a user-preference subscription lookup", async (change) => {
    const lookup = createDeferred<BoundWebPushSubscription | null>();
    vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockReturnValueOnce(lookup.promise);
    const invocation = createInvocation("push.web.preferences.set", "user");
    const pending = invocation.invoke().then(
      () => null,
      (error: unknown) => error,
    );
    expect(findBoundWebPushSubscriptionByEndpoint).toHaveBeenCalledOnce();
    expect(setUserPreferences).not.toHaveBeenCalled();
    if (change === "invalidated client") {
      invocation.client.invalidated = true;
    }
    if (change === "request abort") {
      invocation.request.abort();
    }
    if (change === "scope downgrade") {
      invocation.client.connect.scopes = ["operator.read"];
    }
    if (change === "profile switch") {
      invocation.client.authenticatedUserProfile = {
        ...expectDefined(invocation.client.authenticatedUserProfile, "bound profile"),
        profileId: "different-profile",
      };
    }
    if (change === "session guard revoked") {
      invocation.sessionMutationCommitGuard.mockImplementation(() => {
        throw new Error("request owner retired");
      });
    }
    if (change === "caller authority revoked") {
      invocation.hasCurrentClientAuthority.mockReturnValue(false);
    }
    if (change === "reconnect only") {
      invocation.reconnect();
    }
    lookup.resolve(subscription());
    const error = await pending;
    if (change === "reconnect only") {
      expect(error).toBeNull();
      expect(setUserPreferences).toHaveBeenCalledWith("profile-owner", expect.any(Object));
      expect(invocation.broadcast).toHaveBeenCalledOnce();
      expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
    } else {
      expect(setUserPreferences).not.toHaveBeenCalled();
      expect(invocation.broadcast).not.toHaveBeenCalled();
      expect(error !== null || invocation.respond.mock.calls[0]?.[0] === false).toBe(true);
    }
  });

  describe.each([
    "push.web.subscribe",
    "push.web.preferences.set",
    "push.web.unsubscribe",
  ] as const)("%s queued persistence", (method) => {
    it.each(["revocation", "reconnect only"] as const)(
      "preserves accepted authority after %s at the write boundary",
      async (change) => {
        const entered = createDeferred();
        const release = createDeferred();
        const persisted = vi.fn();
        const beforeWrite = async (params: { guard?: WebPushMutationGuard }) => {
          entered.resolve();
          await release.promise;
          params.guard?.assertCurrent();
          if (params.guard?.family === "worker") {
            params.guard.assertProfiles({ profileId: "profile-owner", bindingCurrent: true });
          }
          persisted();
        };
        vi.mocked(registerWebPushSubscription).mockImplementation(async (params) => {
          await beforeWrite(params);
          return subscription();
        });
        vi.mocked(setWebPushSubscriptionPreferences).mockImplementation(async (params) => {
          await beforeWrite(params);
          return true;
        });
        vi.mocked(clearBoundWebPushSubscription).mockImplementation(async (params) => {
          await beforeWrite(params);
          return true;
        });
        const invocation = createInvocation(method);
        const pending = invocation.invoke().then(
          () => null,
          (error: unknown) => error,
        );
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("handler completed before queued persistence");
            }),
          ]);
          expect(persisted).not.toHaveBeenCalled();
          if (change === "revocation") {
            invocation.client.invalidated = true;
          } else {
            invocation.reconnect();
          }
          release.resolve();
          const error = await pending;
          if (change === "revocation") {
            expect(persisted).not.toHaveBeenCalled();
            expect(error !== null || invocation.respond.mock.calls[0]?.[0] === false).toBe(true);
          } else {
            expect(error).toBeNull();
            expect(persisted).toHaveBeenCalledOnce();
            expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
          }
        } finally {
          release.resolve();
          await pending;
        }
      },
    );

    it.each(["merged alias", "profileless"] as const)("preserves %s ownership", async (owner) => {
      const invocation = createInvocation(method);
      if (owner === "merged alias") {
        vi.mocked(resolveUserProfileId).mockImplementation((id) =>
          id === "retired-profile" ? "profile-owner" : id,
        );
        expectDefined(invocation.client.authenticatedUserProfile, "bound profile").profileId =
          "retired-profile";
        vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(subscription());
      } else {
        delete invocation.client.authenticatedUserProfile;
        vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(subscription(null));
      }
      await invocation.invoke();
      expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
    });
  });
});
