// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import { createPendingSendMessage } from "../pages/chat/chat-send-queue-state.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

const profile: UserProfile = {
  id: "profile-1",
  displayName: "Test Person",
  emails: ["test@example.test"],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
};
const hello = (scopes = ["operator.sessions.write"]) => ({
  ...HELLO,
  auth: { role: "operator", scopes },
  snapshot: { presence: [] },
});
let gateway: ReturnType<typeof createStore>["gateway"];
let current: ReturnType<typeof createStore>["current"];

function presence(user: AuthenticatedUser) {
  return { presence: [{ instanceId: current().instanceId, user }] };
}
function publishPresence(user: AuthenticatedUser) {
  current().opts.onEvent?.(createGatewayEvent("presence", presence(user)));
}

beforeEach(() => {
  stubGatewayStoreTestGlobals();
  vi.useFakeTimers();
  ({ gateway, current } = createStore());
});
afterEach(() => {
  gateway.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Gateway self-profile ownership", () => {
  it.each([false, true])(
    "retains only resolved profileless identity through same-connection drops (retry: %s)",
    async (willRetry) => {
      expect(gateway.snapshot.selfUser).toBeUndefined();
      gateway.start();
      expect(gateway.snapshot.selfUser).toBeUndefined();
      current().opts.onHello?.(hello([]));
      expect(gateway.snapshot.selfUser).toBeNull();
      current().opts.onClose?.({ code: 1006, reason: "lost", willRetry });
      expect(gateway.snapshot.phase).toBe(willRetry ? "reconnecting" : "offline");
      expect(gateway.snapshot.selfUser).toBeNull();
      gateway.connect();
      expect(gateway.snapshot.selfUser).toBeNull();
      const pending = createDeferred<{ profile: UserProfile }>();
      current().request.mockReturnValue(pending.promise);
      current().opts.onHello?.(hello());
      const read = gateway.loadSelfProfile();
      expect(gateway.snapshot.selfUser).toBeUndefined();
      current().opts.onClose?.({ code: 1006, reason: "lost", willRetry: true });
      expect(gateway.snapshot.selfUser).toBeUndefined();
      pending.reject(
        new GatewayRequestError({ code: "FORBIDDEN", message: "Old profileless result" }),
      );
      expect(await read).toBeNull();
      expect(gateway.snapshot.selfUser).toBeUndefined();
      gateway.stop();
      expect(gateway.snapshot.selfUser).toBeUndefined();
    },
  );

  it.each([
    { token: "replacement-token" },
    { password: "replacement-password" },
    { bootstrapToken: "replacement-bootstrap" },
    { gatewayUrl: "ws://other.test" },
  ])("retires profileless identity when connection credentials change: %j", (replacement) => {
    gateway.start();
    current().opts.onHello?.(hello([]));
    expect(gateway.snapshot.selfUser).toBeNull();
    gateway.connect(replacement);
    expect(gateway.snapshot.selfUser).toBeUndefined();
    current().opts.onClose?.({ code: 1006, reason: "lost", willRetry: true });
    expect(gateway.snapshot.selfUser).toBeUndefined();
  });

  it.each(["pairing rejection", "authentication rejection", "retired recovery", "stop"])(
    "retires profileless identity on %s",
    (retirement) => {
      gateway.start();
      current().opts.onHello?.(hello([]));
      expect(gateway.snapshot.selfUser).toBeNull();
      if (retirement === "stop") {
        gateway.stop();
      } else {
        if (retirement === "retired recovery") {
          Object.defineProperty(current(), "offlineRecoveryRetired", { value: true });
        }
        current().opts.onClose?.({
          code: 1008,
          reason: "Access retired",
          willRetry: false,
          ...(retirement === "pairing rejection"
            ? { error: { code: "PAIRING_REQUIRED", message: "Pair again" } }
            : retirement === "authentication rejection"
              ? { error: { code: "UNAUTHORIZED", message: "Sign in again" } }
              : {}),
        });
      }
      expect(gateway.snapshot.selfUser).toBeUndefined();
      gateway.connect();
      expect(gateway.snapshot.selfUser).toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps a fast queued send attributed while self loading is pending or fails (%s)",
    async (fail) => {
      gateway.start();
      const deferred = createDeferred<{ profile: UserProfile }>();
      current().request.mockReturnValue(deferred.promise);
      current().opts.onHello?.({
        ...hello(["operator.read"]),
        snapshot: presence({
          id: profile.id,
          name: profile.displayName ?? undefined,
          identity: { type: "profile", id: profile.id },
        }),
      });
      expect(current().request).not.toHaveBeenCalled();
      const read = gateway.loadSelfProfile();
      const queued = () =>
        createPendingSendMessage(
          makeChatHost({
            client: gateway.snapshot.client,
            hello: gateway.snapshot.hello,
            selfUser: gateway.snapshot.selfUser,
          }),
          "hello",
        )?.item;
      const pending = queued();
      expect(pending?.sender).toMatchObject({
        id: profile.id,
        name: profile.displayName,
        identity: { type: "profile", id: profile.id },
      });
      if (fail) {
        deferred.reject(
          new GatewayRequestError({ code: "UNAVAILABLE", message: "Self read failed" }),
        );
        await expect(read).rejects.toThrow("Self read failed");
      } else {
        deferred.resolve({ profile });
        await read;
      }
      expect(queued()?.sender?.id).toBe(profile.id);
      expect(pending?.sender?.id).toBe(profile.id);
      gateway.connect();
      expect(queued()?.sender).toBeUndefined();
    },
  );

  it.each(["FORBIDDEN", "UNAVAILABLE"])(
    "keeps self reads unidentified on %s and permits retry",
    async (code) => {
      gateway.start();
      current().opts.onHello?.(hello([]));
      expect(await gateway.loadSelfProfile()).toBeNull();
      expect(current().request).not.toHaveBeenCalled();
      current().request.mockRejectedValueOnce(
        new GatewayRequestError({
          code,
          message: "Identity pending",
          retryable: code === "UNAVAILABLE",
        }),
      );
      current().opts.onHello?.(hello());
      const read = gateway.loadSelfProfile();
      if (code === "FORBIDDEN") {
        expect(await read).toBeNull();
      } else {
        await expect(read).rejects.toThrow("Identity pending");
      }
      expect(gateway.snapshot.selfUser).toBe(code === "FORBIDDEN" ? null : undefined);
      const owner = { ...profile, id: "owner", displayName: null, emails: [] };
      current().request.mockResolvedValue({ profile: owner });
      expect(await gateway.loadSelfProfile()).toEqual(owner);
      expect(gateway.snapshot.selfUser).toMatchObject({
        id: "owner",
        identity: { type: "profile", id: "owner" },
      });
    },
  );

  it.each(["reconnect", "attached identity"])(
    "retires a pending self read after %s",
    async (replacement) => {
      gateway.start();
      const pending = createDeferred<{ profile: UserProfile }>();
      const nextRead = createDeferred<{ profile: UserProfile }>();
      current().request.mockReturnValueOnce(pending.promise).mockReturnValueOnce(nextRead.promise);
      current().opts.onHello?.(hello(replacement === "reconnect" ? undefined : ["operator.read"]));
      const oldRead = gateway.loadSelfProfile();
      const attached = {
        id: "profile-2",
        identity: { type: "profile" as const, id: "profile-2" },
        name: "Second Person",
      };
      if (replacement === "reconnect") {
        current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
        expect(gateway.snapshot.selfUser).toBeUndefined();
        current().opts.onHello?.(hello());
        const read = gateway.loadSelfProfile();
        const nextProfile = { ...profile, id: attached.id, displayName: attached.name };
        nextRead.resolve({ profile: nextProfile });
        expect(await read).toEqual(nextProfile);
      } else {
        publishPresence(attached);
      }
      pending.resolve({ profile });
      expect(await oldRead).toBeNull();
      expect(gateway.snapshot.selfUser?.id).toBe(attached.id);
      if (replacement === "attached identity") {
        expect(gateway.snapshot.selfUser).toEqual(attached);
      }
    },
  );

  it("refreshes canonical profile and avatar via profile events", async () => {
    gateway.start();
    current().request.mockResolvedValue({ profile });
    current().opts.onHello?.(hello());
    await gateway.loadSelfProfile();
    expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=2");
    const changed = {
      ...profile,
      id: "merged-profile",
      displayName: "Changed Person",
      updatedAt: 3,
    };
    current().request.mockResolvedValue({ profile: changed });
    current().opts.onEvent?.(
      createGatewayEvent("sessions.changed", { reason: "profile-identity" }),
    );
    await gateway.loadSelfProfile();
    publishPresence({ id: profile.id, name: "Old alias" });
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: changed.id,
      name: changed.displayName,
    });
    expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=3");
    expect(current().request).toHaveBeenCalledTimes(2);
  });

  it("preserves current-profile display events and upload revisions through a pending self read", async () => {
    gateway.start();
    current().request.mockResolvedValue({ profile });
    current().opts.onHello?.(hello(["operator.read"]));
    await gateway.loadSelfProfile();
    const pending = createDeferred<{ profile: UserProfile }>();
    current().request.mockReturnValueOnce(pending.promise);
    const read = gateway.loadSelfProfile();
    const user = {
      id: profile.id,
      name: "New Name",
      avatarUrl: "/api/users/profile-1/avatar?v=content-hash",
    };
    publishPresence(user);
    pending.resolve({ profile });
    await read;
    expect(gateway.snapshot.selfUser).toMatchObject({
      ...user,
      email: profile.emails[0],
      identity: { type: "profile", id: profile.id },
    });
    gateway.updateSelfUser?.({
      avatarUrl: "/api/users/profile-1/avatar?v=uploaded-content-hash",
    });
    await gateway.loadSelfProfile();
    expect(gateway.snapshot.selfUser?.avatarUrl).toBe(
      "/api/users/profile-1/avatar?v=uploaded-content-hash",
    );
  });

  it("does not return an identity retired by a synchronous snapshot observer", async () => {
    gateway.start();
    current().request.mockResolvedValue({ profile });
    gateway.subscribe((snapshot) => {
      if (snapshot.selfUser) {
        gateway.stop();
      }
    });
    current().opts.onHello?.(hello());
    expect(await gateway.loadSelfProfile()).toBeNull();
    expect(gateway.snapshot.selfUser).toBeUndefined();
  });
});
