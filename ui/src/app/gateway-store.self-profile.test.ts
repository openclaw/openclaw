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

  it.each(["FORBIDDEN", "UNAVAILABLE"])(
    "keeps self reads unidentified on %s and permits retry",
    async (code) => {
      const { gateway, current } = createStore();
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
      expect(gateway.snapshot.selfUser).toBeNull();
      const owner = { ...profile, id: "owner", displayName: null, emails: [] };
      current().request.mockResolvedValue({ profile: owner });
      expect(await gateway.loadSelfProfile()).toEqual(owner);
      expect(gateway.snapshot.selfUser).toMatchObject({
        id: "owner",
        identity: { type: "profile", id: "owner" },
      });
      gateway.stop();
    },
  );

  it.each(["reconnect", "attached identity"])(
    "retires a pending self read after %s",
    async (replacement) => {
      const { gateway, current } = createStore();
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
        expect(gateway.snapshot.selfUser).toBeNull();
        current().opts.onHello?.(hello());
        const read = gateway.loadSelfProfile();
        const nextProfile = { ...profile, id: attached.id, displayName: attached.name };
        nextRead.resolve({ profile: nextProfile });
        expect(await read).toEqual(nextProfile);
      } else {
        current().opts.onEvent?.(
          createGatewayEvent("presence", {
            presence: [{ instanceId: current().instanceId, user: attached }],
          }),
        );
      }
      pending.resolve({ profile });
      expect(await oldRead).toBeNull();
      expect(gateway.snapshot.selfUser?.id).toBe(attached.id);
      if (replacement === "attached identity") {
        expect(gateway.snapshot.selfUser).toEqual(attached);
      }
      gateway.stop();
    },
  );

  it.each(["profile event", "explicit read"])(
    "refreshes canonical profile and avatar via %s",
    async (trigger) => {
      const { gateway, current } = createStore();
      gateway.start();
      current().request.mockResolvedValue({ profile });
      current().opts.onHello?.(hello());
      await gateway.loadSelfProfile();
      expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=2");
      const changed = {
        ...profile,
        id: trigger === "profile event" ? "merged-profile" : profile.id,
        displayName: "Changed Person",
        updatedAt: 3,
      };
      current().request.mockResolvedValue({ profile: changed });
      if (trigger === "profile event") {
        current().opts.onEvent?.(
          createGatewayEvent("sessions.changed", { reason: "profile-identity" }),
        );
      }
      await gateway.loadSelfProfile();
      if (trigger === "profile event") {
        current().opts.onEvent?.(
          createGatewayEvent("presence", {
            presence: [
              { instanceId: current().instanceId, user: { id: profile.id, name: "Old alias" } },
            ],
          }),
        );
      }
      expect(gateway.snapshot.selfUser).toMatchObject({
        id: changed.id,
        name: changed.displayName,
      });
      expect(gateway.snapshot.selfUser?.avatarUrl).toContain("?v=3");
      expect(current().request).toHaveBeenCalledTimes(2);
      gateway.stop();
    },
  );

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
});
