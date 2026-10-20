import { expect, it, vi } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
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

function setup(
  request: Parameters<typeof createTestGatewayClient>[0],
  overrides: Partial<ApplicationGateway["snapshot"]> = {},
) {
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  const publish = (patch: Partial<ApplicationGateway["snapshot"]>) =>
    fixture.publish({ ...gateway.snapshot, ...patch });
  publish({
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
    client: createTestGatewayClient(request),
    ...overrides,
  });
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(vi.fn());
  return { gateway, publish, directory, stop };
}

it.each(["account", "recovery scope"])(
  "retires profiles when the same client's %s changes",
  async (change) => {
    const pending = createDeferred<UsersListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [photo] })
      .mockReturnValue(pending.promise);
    const hello = gatewayHelloForMethods(["users.list"], ["operator.read"]);
    hello.auth!.recoveryScope = "alice-scope";
    const { publish, directory, stop } = setup(request, {
      hello,
      selfUser: { id: "alice", name: "Alice" },
    });
    await directory.load();
    const old = directory.load(true);
    publish(
      change === "account"
        ? { selfUser: { id: "bob", name: "Bob" } }
        : {
            selfUser: undefined,
            hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
          },
    );
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
  const hello = gatewayHelloForMethods(["users.list"], ["operator.read"]);
  const { publish, directory, stop } = setup(request, { hello });
  await directory.load();
  publish({ phase: "reconnecting", hello: null });
  expect(directory.get("photo")).toEqual(photo);
  publish({ phase: "connected", hello });
  expect(directory.get("photo")).toEqual(photo);
  publish({ hello: gatewayHelloForMethods(["users.list"], []) });
  expect(directory.get("photo")).toBeUndefined();
  refreshed.resolve({ profiles: [photo] });
  await directory.load();
  expect(directory.get("photo")).toBeUndefined();
  stop();
});

it("shares directory reads, resolves merged identities, and advertises uploaded and email-backed photos", async () => {
  const reply = createDeferred<UsersListResult>();
  const request = vi.fn(() => reply.promise);
  const { gateway, directory, stop: first } = setup(request);
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
  const { publish, directory, stop } = setup(request);
  const old = directory.load();
  publish({ phase: "offline" });
  reply.resolve({ profiles: [photo] });
  await old;
  expect(profileAvatarUrl(directory.get("photo"))).toBeUndefined();
  publish({
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
  const { publish, directory, stop } = setup(request, {
    hello: gatewayHelloForMethods(["users.list"], ["operator.sessions.write"]),
  });
  await directory.load();
  expect(request).not.toHaveBeenCalled();
  publish({
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
  });
  await directory.load();
  expect(request).toHaveBeenCalledTimes(1);
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
  stop();
});
