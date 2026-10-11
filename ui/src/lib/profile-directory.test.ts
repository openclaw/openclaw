import { expect, it, vi } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { profileAvatarUrl, profileDirectory } from "./profile-directory.ts";

const photo = {
  id: "photo",
  displayName: "Photo Person",
  hasAvatar: true,
  updatedAt: 7,
  createdAt: 1,
  avatarMime: null,
  mergedInto: null,
  emails: [],
  githubIdentity: null,
};

it("shares directory reads, resolves merged identities, and advertises only existing photos", async () => {
  const reply = createDeferred<UsersListResult>();
  const request = vi.fn(() => reply.promise);
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
    client: createTestGatewayClient(request),
  });
  const directory = profileDirectory(gateway);
  const first = directory.subscribe(vi.fn());
  const second = profileDirectory(gateway).subscribe(vi.fn());
  expect(request).toHaveBeenCalledTimes(1);
  expect(profileAvatarUrl(directory.get("photo"))).toBeUndefined();
  reply.resolve({
    profiles: [
      photo,
      { ...photo, id: "absent", hasAvatar: false },
      { ...photo, id: "old", mergedInto: "photo", hasAvatar: false },
      { ...photo, id: "cycle", mergedInto: "cycle" },
    ],
  });
  await directory.load();
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("old"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("absent"))).toBeUndefined();
  expect(profileAvatarUrl(directory.get("unknown"))).toBeUndefined();
  expect(directory.get("cycle")).toBeUndefined();
  first();
  second();
});

it("retires directory facts and ignores pending replies when the connection is replaced", async () => {
  const reply = createDeferred<UsersListResult>();
  const request = vi.fn(() => reply.promise);
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
    client: createTestGatewayClient(request),
  });
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(vi.fn());
  const old = directory.load();
  fixture.publish({ ...gateway.snapshot, phase: "offline" });
  reply.resolve({ profiles: [photo] });
  await old;
  expect(profileAvatarUrl(directory.get("photo"))).toBeUndefined();
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(async () => ({ profiles: [{ ...photo, updatedAt: 8 }] })),
  });
  await directory.load();
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=8");
  stop();
  expect(directory.get("photo")).toBeUndefined();
});

it("waits for roster access while a profile-only guest stays on known identity", async () => {
  const request = vi.fn(async () => ({ profiles: [photo] }));
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
    hello: gatewayHelloForMethods(["users.list"], ["operator.sessions.write"]),
  });
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(vi.fn());
  await directory.load();
  expect(request).not.toHaveBeenCalled();
  fixture.publish({
    ...gateway.snapshot,
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
  });
  await directory.load();
  expect(request).toHaveBeenCalledTimes(1);
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
  stop();
});
