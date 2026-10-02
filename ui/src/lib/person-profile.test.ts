import { expect, it, vi } from "vitest";
import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { observePersonProfile } from "./person-profile.ts";

const profile: UserProfile = {
  id: "profile-alice",
  displayName: "Alice",
  role: "guest",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
};

function fixture(request: GatewayBrowserClient["request"]) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list", "users.self"], ["operator.read"]),
    selfUser: null,
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway: Pick<
    ApplicationGateway,
    "snapshot" | "connectionRevision" | "subscribeEvents" | "loadSelfProfile"
  > = {
    get snapshot() {
      return snapshot;
    },
    connectionRevision: 1,
    loadSelfProfile: async () => profile,
    subscribeEvents(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  return {
    gateway,
    listeners,
    invalidate() {
      for (const callback of listeners) {
        callback({
          type: "event",
          event: "sessions.changed",
          payload: { reason: "profile-identity" },
        });
      }
    },
    downgrade() {
      snapshot = {
        ...snapshot,
        hello: gatewayHelloForMethods(["users.list", "users.self"], ["operator.sessions.read"]),
      };
    },
  };
}

it("retires an initial profile read when a profile mutation starts a successor", async () => {
  const old = createDeferred<UsersListResult>();
  const current = createDeferred<UsersListResult>();
  const rendered = createDeferred();
  const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const f = fixture(request);
  const reader = observePersonProfile(f.gateway, profile.id, () => {
    if (reader.profile?.role === "maintainer") {
      rendered.resolve();
    }
  });
  expect(reader.profile).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  f.invalidate();
  expect(reader.profile).toBeUndefined();
  current.resolve({ profiles: [{ ...profile, role: "maintainer" }] });
  await rendered.promise;
  old.resolve({ profiles: [{ ...profile, role: "retired-role" }] });
  await old.promise;
  await Promise.resolve();
  expect(reader.profile?.role).toBe("maintainer");
  expect(request).toHaveBeenCalledTimes(2);
  reader.dispose();
  f.invalidate();
  expect(request).toHaveBeenCalledTimes(2);
  expect(f.listeners.size).toBe(0);
});

it.each(["dispose", "downgrade"])("rejects a pending role read after %s", async (action) => {
  const reply = createDeferred<UsersListResult>();
  const request = vi.fn().mockReturnValue(reply.promise);
  const f = fixture(request);
  const changed = vi.fn();
  const reader = observePersonProfile(f.gateway, profile.id, changed);
  if (action === "dispose") {
    reader.dispose();
  } else {
    f.downgrade();
  }
  reply.resolve({ profiles: [{ ...profile, role: "maintainer" }] });
  await reply.promise;
  await Promise.resolve();
  expect(reader.profile).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  reader.dispose();
  expect(f.listeners.size).toBe(0);
});
