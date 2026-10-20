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

it.each(["account", "recovery scope"])(
  "retires profiles when the same client's %s changes",
  async (change) => {
    const pending = createDeferred<UsersListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [photo] })
      .mockReturnValue(pending.promise);
    const source = createApplicationGateway();
    const hello = gatewayHelloForMethods(["users.list"], ["operator.read"]);
    hello.auth!.recoveryScope = "alice-scope";
    source.publish({
      ...source.gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello,
      selfUser: { id: "alice", name: "Alice" },
    });
    const directory = profileDirectory(source.gateway);
    const stop = directory.subscribe(() => {});
    await directory.load();
    const old = directory.load(true);
    source.publish({
      ...source.gateway.snapshot,
      ...(change === "account"
        ? { selfUser: { id: "bob", name: "Bob" } }
        : {
            selfUser: undefined,
            hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
          }),
    });
    expect(directory.get("photo")).toBeUndefined();
    pending.resolve({ profiles: [] });
    await old;
    await directory.load();
    expect(directory.get("photo")).toBeUndefined();
    stop();
  },
);

it("retains profiles during a blip and clears them on fresh access loss", async () => {
  const refreshed = createDeferred<UsersListResult>();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ profiles: [photo] })
    .mockReturnValue(refreshed.promise);
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  const hello = gatewayHelloForMethods(["users.list"], ["operator.read"]);
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    hello,
    client: createTestGatewayClient(request),
  });
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(() => {});
  await directory.load();
  fixture.publish({ ...gateway.snapshot, phase: "reconnecting", hello: null });
  expect(directory.get("photo")).toEqual(photo);
  fixture.publish({ ...gateway.snapshot, phase: "connected", hello });
  expect(directory.get("photo")).toEqual(photo);
  fixture.publish({ ...gateway.snapshot, hello: gatewayHelloForMethods(["users.list"], []) });
  expect(directory.get("photo")).toBeUndefined();
  refreshed.resolve({ profiles: [photo] });
  await directory.load();
  expect(directory.get("photo")).toBeUndefined();
  stop();
});

it("shares directory reads, resolves merged identities, and advertises uploaded and email-backed photos", async () => {
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
      { ...photo, id: "gravatar", hasAvatar: false, emails: ["vince@example.com"] },
      { ...photo, id: "old", mergedInto: "photo", hasAvatar: false },
      { ...photo, id: "cycle", mergedInto: "cycle" },
    ],
  });
  await directory.load();
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("old"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("absent"))).toBeUndefined();
  expect(profileAvatarUrl(directory.get("gravatar"))).toBe("/api/users/gravatar/avatar?v=7");
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
