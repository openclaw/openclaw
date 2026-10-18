import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WebPushMutationGuard } from "../../infra/push-web-store.records.js";
import {
  clearBoundWebPushSubscription,
  registerWebPushSubscription,
  setWebPushSubscriptionPreferences,
  type BoundWebPushSubscription,
} from "../../infra/push-web.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { pushHandlers } from "./push.js";
import { holdPushStorage, pushClient, pushSubscription } from "./push.test-support.js";

const { findBoundWebPushSubscriptionByEndpoint, resolveProfileId, snapshotScope } = vi.hoisted(
  () => ({
    findBoundWebPushSubscriptionByEndpoint:
      vi.fn<(params: { endpoint: string }) => Promise<BoundWebPushSubscription | null>>(),
    resolveProfileId: vi.fn<(profileId: string) => string | undefined>(),
    snapshotScope: { active: false },
  }),
);

// mock-isolation: Keep APNs registration and delivery outside the Web Push authority fixture.
vi.mock("../../infra/push-apns.js", async () =>
  (await import("./push.test-support.js")).mockPushApns(),
);
// mock-isolation: Bind subscription lookup to synthetic authority snapshots without real storage.
vi.mock("../../infra/push-web.js", async () => ({
  ...(await import("./push.test-support.js")).mockPushWeb(),
  withBoundWebPushSubscriptionByEndpoint: async <T>(
    params: { endpoint: string },
    prepare: (
      subscription: BoundWebPushSubscription | null,
    ) => { start: () => T } | undefined | Promise<{ start: () => T } | undefined>,
  ) => {
    const snapshotSubscription = await findBoundWebPushSubscriptionByEndpoint(params);
    snapshotScope.active = true;
    try {
      return (await prepare(snapshotSubscription))?.start();
    } finally {
      snapshotScope.active = false;
    }
  },
}));
vi.mock("../../state/user-preferences.js", () => ({
  getCanonicalUserPreferences: vi.fn(async () => ({ profileId: "profile-owner", entries: {} })),
  setCanonicalUserPreferences: vi.fn(),
}));
// mock-isolation: Synthetic authority exercises revocation without profile storage.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileSelectionAuthority: vi.fn(),
}));
// mock-isolation: Synthetic recipients avoid opening a shared-state worker.
vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileCatalog: async () => ({
    readCurrentIdentity: (id: string) => ({ profileId: resolveProfileId(id) }),
    release: vi.fn(),
  }),
}));

const endpoint = "https://push.example.test/authority";
const keys = { p256dh: "synthetic-p256dh", auth: "synthetic-auth" };
const userPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: true,
    agentQuestion: true,
    humanMentioned: true,
    scheduledTaskFailed: true,
  },
  detailLevel: "private",
  quietHours: { enabled: false, startMinute: 0, endMinute: 0, timeZone: "UTC" },
  agentIds: [],
};
type WriteMethod =
  | "push.web.subscribe"
  | "push.web.preferences.get"
  | "push.web.preferences.set"
  | "push.web.unsubscribe";

function subscription(userProfileId: string | null = "profile-owner"): BoundWebPushSubscription {
  return {
    ...pushSubscription(endpoint, keys, "subscription-owner"),
    deviceId: "browser-device",
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

function expectUnpublished(invocation: ReturnType<typeof createInvocation>) {
  expect(invocation.respond).not.toHaveBeenCalled();
  expect(invocation.broadcast).not.toHaveBeenCalled();
}

function createInvocation(method: WriteMethod, scope: "user" | "device" = "device") {
  const transport = new AbortController();
  const request = new AbortController();
  const client = pushClient(
    "profile-owner",
    "original-connection",
    transport.signal,
    "browser-device",
    ["operator.read", "operator.write"],
  );
  const broadcast = vi.fn();
  const options = {
    req: { type: "req", id: "authority-request", method },
    params: {
      endpoint,
      ...(method === "push.web.subscribe" ? { keys } : {}),
      ...(method === "push.web.preferences.set"
        ? {
            scope,
            preferences: scope === "device" ? { enabled: true, label: "Browser" } : userPreferences,
          }
        : {}),
    },
    client,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: () => ({}),
      getClientConnIds: () => new Set(["current-connection"]),
      broadcastToConnIds: broadcast,
    },
    isWebchatConnect: () => false,
    signal: request.signal,
    hasCurrentClientAuthority: vi.fn(() => true),
    sessionMutationCommitGuard: vi.fn(),
  } satisfies Parameters<(typeof pushHandlers)["push.web.preferences.set"]>[0];
  return {
    ...options,
    request,
    broadcast,
    reconnect() {
      transport.abort();
    },
    invoke: () => Promise.resolve(expectDefined(pushHandlers[method], "Web Push handler")(options)),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  snapshotScope.active = false;
  resolveProfileId.mockImplementation((id) => id);
  vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(subscription());
  vi.mocked(registerWebPushSubscription).mockResolvedValue(subscription());
  vi.mocked(setWebPushSubscriptionPreferences).mockResolvedValue(true);
  vi.mocked(clearBoundWebPushSubscription).mockResolvedValue(true);
  vi.mocked(setCanonicalUserPreferences).mockImplementation(async () => {
    expect(snapshotScope.active).toBe(true);
    return { ok: true, value: { profileId: "profile-owner" } };
  });
  vi.mocked(prepareUserProfileSelectionAuthority).mockImplementation(async (id) => {
    const profileId = resolveProfileId(id);
    return profileId
      ? { profileId, isCurrent: () => resolveProfileId(id) === profileId }
      : undefined;
  });
});

describe("Web Push request authority across asynchronous storage", () => {
  it.each(["unchanged", "profile changed", "request revoked", "rejected"] as const)(
    "waits for preference reads and checks authority: %s",
    async (change) => {
      const storage = holdPushStorage();
      let profileCurrent = true;
      vi.mocked(prepareUserProfileSelectionAuthority).mockResolvedValue({
        profileId: "profile-owner",
        isCurrent: () => profileCurrent,
      });
      vi.mocked(getCanonicalUserPreferences).mockImplementation(async () => {
        await storage.wait();
        if (change === "rejected") {
          throw new Error("worker read failed");
        }
        return {
          profileId: "profile-owner",
          entries: { "notifications.web.v1": { detailLevel: "detailed" } },
        };
      });
      const invocation = createInvocation("push.web.preferences.get");
      const error = await storage.settle(
        invocation.invoke().catch((failure: unknown) => failure),
        () => {
          expect(snapshotScope.active).toBe(true);
          expect(invocation.respond).not.toHaveBeenCalled();
          if (change === "profile changed") {
            profileCurrent = false;
          } else if (change === "request revoked") {
            invocation.request.abort();
          }
        },
      );
      if (change === "unchanged") {
        expect(error).toBeUndefined();
        expect(invocation.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            durableIdentity: true,
            user: expect.objectContaining({ detailLevel: "detailed" }),
          }),
          undefined,
        );
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(invocation.respond).not.toHaveBeenCalled();
      }
      expect(snapshotScope.active).toBe(false);
    },
  );

  it.each([
    "unchanged",
    "admission revoked",
    "commit revoked",
    "completion revoked",
    "rejected",
  ] as const)("publishes preferences only after the guarded write settles: %s", async (change) => {
    const storage = holdPushStorage();
    const committed = vi.fn();
    let profileCurrent = true;
    vi.mocked(prepareUserProfileSelectionAuthority).mockResolvedValue({
      profileId: "profile-owner",
      isCurrent: () => profileCurrent,
    });
    vi.mocked(setCanonicalUserPreferences).mockImplementation(async (_id, _entries, options) => {
      await storage.wait();
      const assertCurrent = expectDefined(options?.assertCurrent, "preference admission guard");
      assertCurrent();
      if (change === "commit revoked") {
        profileCurrent = false;
      }
      assertCurrent();
      if (change === "rejected") {
        throw new Error("worker write failed");
      }
      committed();
      if (change === "completion revoked") {
        profileCurrent = false;
      }
      return { ok: true, value: { profileId: "profile-owner" } };
    });
    const invocation = createInvocation("push.web.preferences.set", "user");
    const error = await storage.settle(
      invocation.invoke().catch((failure: unknown) => failure),
      () => {
        expect(snapshotScope.active).toBe(true);
        expectUnpublished(invocation);
        if (change === "admission revoked") {
          invocation.client.invalidated = true;
        }
      },
    );
    if (change === "unchanged") {
      expect(error).toBeUndefined();
      expect(committed).toHaveBeenCalledOnce();
      expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
      expect(invocation.broadcast).toHaveBeenCalledOnce();
    } else {
      expect(error).toBeInstanceOf(Error);
      expect(committed).toHaveBeenCalledTimes(change === "completion revoked" ? 1 : 0);
      expectUnpublished(invocation);
    }
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
    const pending = invocation.invoke().catch((error: unknown) => error);
    expect(findBoundWebPushSubscriptionByEndpoint).toHaveBeenCalledOnce();
    expect(setCanonicalUserPreferences).not.toHaveBeenCalled();
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
      expect(error).toBeUndefined();
      expect(setCanonicalUserPreferences).toHaveBeenCalledOnce();
      expect(setCanonicalUserPreferences).toHaveBeenCalledWith(
        "profile-owner",
        expect.any(Object),
        { assertCurrent: expect.any(Function) },
      );
      expect(invocation.broadcast).toHaveBeenCalledOnce();
      expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
      expect(snapshotScope.active).toBe(false);
    } else {
      expect(setCanonicalUserPreferences).not.toHaveBeenCalled();
      expect(invocation.broadcast).not.toHaveBeenCalled();
      expect(error !== undefined || invocation.respond.mock.calls[0]?.[0] === false).toBe(true);
    }
  });

  it.each([
    ["push.web.preferences.set", "revocation"],
    ["push.web.preferences.set", "reconnect only"],
    ["push.web.unsubscribe", "revocation"],
    ["push.web.unsubscribe", "reconnect only"],
  ] as const)(
    "%s preserves accepted authority after %s at the write boundary",
    async (method, change) => {
      const storage = holdPushStorage();
      const persisted = vi.fn();
      const beforeWrite = async (params: { guard?: WebPushMutationGuard }) => {
        await storage.wait();
        params.guard?.assertCurrent();
        if (params.guard?.family === "worker") {
          params.guard.assertProfiles({ profileId: "profile-owner", bindingCurrent: true });
        }
        persisted();
        return true;
      };
      vi.mocked(setWebPushSubscriptionPreferences).mockImplementation(beforeWrite);
      vi.mocked(clearBoundWebPushSubscription).mockImplementation(beforeWrite);
      const invocation = createInvocation(method);
      const error = await storage.settle(
        invocation.invoke().catch((failure: unknown) => failure),
        () => {
          expect(persisted).not.toHaveBeenCalled();
          if (change === "revocation") {
            invocation.client.invalidated = true;
          } else {
            invocation.reconnect();
          }
        },
      );
      if (change === "revocation") {
        expect(persisted).not.toHaveBeenCalled();
        expect(error !== undefined || invocation.respond.mock.calls[0]?.[0] === false).toBe(true);
      } else {
        expect(error).toBeUndefined();
        expect(persisted).toHaveBeenCalledOnce();
        expect(invocation.respond.mock.calls[0]?.[0]).toBe(true);
      }
    },
  );

  it.each([
    ["push.web.subscribe", "profileless"],
    ["push.web.preferences.set", "merged alias"],
    ["push.web.preferences.set", "profileless"],
  ] as const)("%s preserves %s ownership", async (method, owner) => {
    const invocation = createInvocation(method);
    if (owner === "merged alias") {
      resolveProfileId.mockImplementation((id) =>
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
