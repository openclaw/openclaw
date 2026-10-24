import { expect, it, onTestFinished, vi } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
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

const rosterHello = (scopes = ["operator.read"]) => gatewayHelloForMethods(["users.list"], scopes);

function fixture(
  initial?: (typeof photo)[],
  overrides: Partial<ApplicationGateway["snapshot"]> = {},
  handler?: GatewayRequestHandler,
) {
  const reply = createDeferred<UsersListResult>();
  const request = vi.fn(handler ?? (() => reply.promise));
  if (initial) {
    request.mockResolvedValueOnce({ profiles: initial });
  }
  const source = createApplicationGateway();
  const { gateway } = source;
  const publish = (patch: Partial<ApplicationGateway["snapshot"]>) =>
    source.publish({ ...gateway.snapshot, ...patch });
  publish({
    phase: "connected",
    hello: rosterHello(),
    client: createTestGatewayClient(request),
    ...overrides,
  });
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(vi.fn());
  onTestFinished(stop);
  return { gateway, publish, directory, stop, reply, request };
}

it.each(["account", "recovery scope"])(
  "retires profiles when the same client's %s changes",
  async (change) => {
    const hello = rosterHello();
    hello.auth!.recoveryScope = "alice-scope";
    const { publish, directory, reply } = fixture([photo], {
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
    reply.resolve({ profiles: [] });
    await old;
    await directory.load();
    expect(directory.get("photo")).toBeUndefined();
  },
);

it("retains profiles during a blip and clears them on fresh access loss", async () => {
  const hello = rosterHello();
  const { publish, directory, reply } = fixture([photo], { hello });
  await directory.load();
  publish({ phase: "reconnecting", hello: null });
  expect(directory.get("photo")).toEqual(photo);
  publish({ phase: "connected", hello });
  expect(directory.get("photo")).toEqual(photo);
  publish({ hello: rosterHello([]) });
  expect(directory.get("photo")).toBeUndefined();
  reply.resolve({ profiles: [photo] });
  await directory.load();
  expect(directory.get("photo")).toBeUndefined();
});

it("shares directory reads, resolves merged identities, and advertises uploaded and email-backed photos", async () => {
  const { gateway, directory, stop: first, request, reply } = fixture();
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
  const { publish, directory, stop, reply } = fixture();
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
  const { publish, directory, request } = fixture(
    undefined,
    { hello: rosterHello(["operator.sessions.write"]) },
    async () => ({ profiles: [photo] }),
  );
  await directory.load();
  expect(request).not.toHaveBeenCalled();
  publish({ hello: rosterHello() });
  await directory.load();
  expect(request).toHaveBeenCalledTimes(1);
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
});
