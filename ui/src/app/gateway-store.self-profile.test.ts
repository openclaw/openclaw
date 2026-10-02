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

beforeEach(() => {
  stubGatewayStoreTestGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Gateway self-profile ownership", () => {
  it.each([
    "operator.sessions.read",
    "operator.sessions.write",
    "operator.read",
    "operator.write",
    "operator.admin",
  ])("loads authenticated self with %s and no roster", async (scope) => {
    const { gateway, current } = createStore();
    gateway.start();
    current().request.mockResolvedValue({ profile });
    current().opts.onHello?.(hello([scope]));
    await Promise.resolve();
    expect(current().request).toHaveBeenCalledWith("users.self", {});
    await gateway.loadSelfProfile();
    expect(current().request).toHaveBeenCalledTimes(1);
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: profile.id,
      identity: { type: "profile", id: profile.id },
      name: profile.displayName,
      email: profile.emails[0],
    });
    expect(gateway.snapshot.hello?.snapshot).toEqual({ presence: [] });
    gateway.stop();
  });

  it.each([false, true])(
    "keeps a fast queued send attributed while self loading is pending or fails (%s)",
    async (fail) => {
      const { gateway, current } = createStore();
      gateway.start();
      const deferred = createDeferred<{ profile: UserProfile }>();
      current().request.mockReturnValue(deferred.promise);
      const admitted = {
        ...hello(["operator.read"]),
        snapshot: {
          presence: [
            {
              instanceId: current().instanceId,
              user: {
                id: profile.id,
                name: profile.displayName ?? undefined,
                identity: { type: "profile" as const, id: profile.id },
              },
            },
          ],
        },
      };
      current().opts.onHello?.(admitted);
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
      gateway.stop();
    },
  );

  it("keeps absent grants and identity-less connections unidentified", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().opts.onHello?.(hello([]));
    expect(await gateway.loadSelfProfile()).toBeNull();
    expect(current().request).not.toHaveBeenCalled();
    current().request.mockRejectedValue(
      new GatewayRequestError({
        code: "FORBIDDEN",
        message: "users.self requires an authenticated user",
      }),
    );
    current().opts.onHello?.(hello());
    expect(await gateway.loadSelfProfile()).toBeNull();
    expect(gateway.snapshot.selfUser).toBeNull();
    gateway.stop();
  });

  it("retires a pending self read on reconnect even when the client is reused", async () => {
    const { gateway, current } = createStore();
    const before = createDeferred<{ profile: UserProfile }>();
    const after = createDeferred<{ profile: UserProfile }>();
    gateway.start();
    current().request.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    current().opts.onHello?.(hello());
    const oldRead = gateway.loadSelfProfile();
    current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
    expect(gateway.snapshot.selfUser).toBeNull();
    current().opts.onHello?.(hello());
    const newRead = gateway.loadSelfProfile();
    const nextProfile = { ...profile, id: "profile-2", displayName: "Second Person" };
    after.resolve({ profile: nextProfile });
    expect(await newRead).toEqual(nextProfile);
    before.resolve({ profile });
    expect(await oldRead).toBeNull();
    expect(gateway.snapshot.selfUser?.id).toBe("profile-2");
    gateway.stop();
  });

  it("refreshes canonical self on profile changes without accepting roster aliases", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().request.mockResolvedValue({ profile });
    current().opts.onHello?.(hello());
    await gateway.loadSelfProfile();
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
    current().opts.onEvent?.(
      createGatewayEvent("presence", {
        presence: [
          { instanceId: current().instanceId, user: { id: profile.id, name: "Old alias" } },
        ],
      }),
    );
    expect(gateway.snapshot.selfUser).toMatchObject({ id: changed.id, name: changed.displayName });
    expect(current().request).toHaveBeenCalledTimes(2);
    gateway.stop();
  });

  it("retires a pending self read when a broad reader receives a new attached identity", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    const pending = createDeferred<{ profile: UserProfile }>();
    current().request.mockReturnValue(pending.promise);
    current().opts.onHello?.(hello(["operator.read"]));
    const oldRead = gateway.loadSelfProfile();
    const attached = {
      id: "profile-2",
      identity: { type: "profile" as const, id: "profile-2" },
      name: "Second Person",
    };
    current().opts.onEvent?.(
      createGatewayEvent("presence", {
        presence: [{ instanceId: current().instanceId, user: attached }],
      }),
    );
    pending.resolve({ profile });
    expect(await oldRead).toBeNull();
    expect(gateway.snapshot.selfUser).toEqual(attached);
    gateway.stop();
  });

  it.each(["operator.sessions.write", "operator.read"])(
    "preserves current-profile display events and upload revisions through a pending self read with %s",
    async (scope) => {
      const { gateway, current } = createStore();
      gateway.start();
      current().request.mockResolvedValue({ profile });
      current().opts.onHello?.(hello([scope]));
      await gateway.loadSelfProfile();
      const pending = createDeferred<{ profile: UserProfile }>();
      current().request.mockReturnValueOnce(pending.promise);
      const read = gateway.loadSelfProfile();
      const user = {
        id: profile.id,
        name: "New Name",
        avatarUrl: "/api/users/profile-1/avatar?v=content-hash",
      };
      current().opts.onEvent?.(
        createGatewayEvent("presence", { presence: [{ instanceId: current().instanceId, user }] }),
      );
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
      gateway.stop();
    },
  );

  it("refreshes a generated avatar fallback when the self profile changes", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().request.mockResolvedValue({ profile });
    current().opts.onHello?.(hello());
    await gateway.loadSelfProfile();
    expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=2");
    current().request.mockResolvedValue({ profile: { ...profile, updatedAt: 3 } });
    await gateway.loadSelfProfile();
    expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=3");
    gateway.stop();
  });

  it("does not return an identity retired by a synchronous snapshot observer", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().request.mockResolvedValue({ profile });
    gateway.subscribe((snapshot) => {
      if (snapshot.selfUser) {
        gateway.stop();
      }
    });
    current().opts.onHello?.(hello());
    expect(await gateway.loadSelfProfile()).toBeNull();
    expect(gateway.snapshot.selfUser).toBeNull();
  });

  it("keeps read failures retryable and accepts an email-less personal owner", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    current().request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Identity pending",
        retryable: true,
      }),
    );
    current().opts.onHello?.(hello());
    await expect(gateway.loadSelfProfile()).rejects.toThrow("Identity pending");
    expect(gateway.snapshot.selfUser).toBeNull();
    const owner = { ...profile, id: "owner", displayName: null, emails: [] };
    current().request.mockResolvedValue({ profile: owner });
    expect(await gateway.loadSelfProfile()).toEqual(owner);
    expect(gateway.snapshot.selfUser).toMatchObject({
      id: "owner",
      identity: { type: "profile", id: "owner" },
    });
    gateway.stop();
  });
});
