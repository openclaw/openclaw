import { expect, it, onTestFinished, vi } from "vitest";
import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
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
  selfRead?: ApplicationGateway["loadSelfProfile"],
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
  if (selfRead) {
    gateway.loadSelfProfile = selfRead;
  }
  const directory = profileDirectory(gateway);
  const stop = directory.subscribe(vi.fn());
  onTestFinished(stop);
  return { gateway, publish, publishEvent: source.publishEvent, directory, stop, reply, request };
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
  expect(directory.readProfile("photo").status).toBe("disconnected");
  publish({ phase: "connected", hello });
  expect(directory.get("photo")).toEqual(photo);
  expect(directory.readProfile("photo").status).toBe("loading");
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
      {
        ...photo,
        id: "github",
        hasAvatar: false,
        githubIdentity: {
          login: "octocat",
          profileUrl: "https://github.com/octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
        },
      },
      { ...photo, id: "gravatar", hasAvatar: false, emails: ["vince@example.com"] },
      { ...photo, id: "old", mergedInto: "photo", hasAvatar: false },
      { ...photo, id: "cycle", mergedInto: "cycle" },
    ],
  });
  await directory.load();
  expect(profileAvatarUrl(directory.get("photo"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("old"))).toBe("/api/users/photo/avatar?v=7");
  expect(profileAvatarUrl(directory.get("absent"))).toBe("/api/users/absent/avatar?v=7");
  expect(profileAvatarUrl(directory.get("github"))).toBe("/api/users/github/avatar?v=7");
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

it("refreshes canonical role facts and retires a reply started before a profile change", async () => {
  const old = createDeferred<UsersListResult>();
  let reads = 0;
  const { directory, publishEvent, request } = fixture([photo], {}, async () =>
    ++reads === 1 ? old.promise : { profiles: [{ ...photo, role: "maintainer" }] },
  );
  await directory.load();
  const pending = directory.load(true);
  publishEvent({
    type: "event",
    event: "sessions.changed",
    payload: { reason: "profile-identity" },
  });
  expect(request).toHaveBeenCalledTimes(3);
  await directory.load();
  expect(directory.get("photo")?.role).toBe("maintainer");
  old.resolve({ profiles: [{ ...photo, role: "guest" }] });
  await pending;
  expect(directory.get("photo")?.role).toBe("maintainer");
});

const selfSnapshot = () => ({
  hello: rosterHello(["operator.sessions.read"]),
  selfUser: { id: "self", name: "Self", identity: { type: "profile" as const, id: "self" } },
});

it("keeps self reads opt-in, self-scoped and separate from directory enumeration", async () => {
  const reply = createDeferred<UserProfile | null>();
  const loadSelf = vi.fn(() => reply.promise);
  const { directory, request } = fixture(undefined, selfSnapshot(), undefined, loadSelf);
  expect(loadSelf).not.toHaveBeenCalled();
  const stop = directory.subscribe(vi.fn(), true);
  onTestFinished(stop);
  const read = directory.load();
  expect(loadSelf).toHaveBeenCalledTimes(1);
  expect(directory.readProfile("other").status).toBe("denied");
  expect(directory.readProfile("self").status).toBe("loading");
  reply.resolve({ ...photo, id: "self", role: "guest" });
  await read;
  expect(directory.readProfile("self")).toMatchObject({
    status: "ready",
    profile: { role: "guest" },
  });
  expect(directory.currentResult).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  stop();
  expect(directory.get("self")).toBeUndefined();
});

it("refreshes self assignments on profile changes without accepting an earlier reply", async () => {
  const stale = createDeferred<UserProfile | null>();
  const own = { ...photo, id: "self", role: "guest" };
  const changed = { ...own, role: "maintainer" };
  const loadSelf = vi
    .fn<ApplicationGateway["loadSelfProfile"]>()
    .mockResolvedValueOnce(own)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue(changed);
  const test = fixture(undefined, selfSnapshot(), undefined, loadSelf);
  onTestFinished(test.directory.subscribe(vi.fn(), true));
  await test.directory.load();
  const old = test.directory.load(true);
  test.publishEvent({
    type: "event",
    event: "sessions.changed",
    payload: { reason: "profile-identity" },
  });
  await test.directory.load();
  expect(test.directory.readProfile("self")).toMatchObject({ profile: { role: "maintainer" } });
  stale.resolve(own);
  await old;
  expect(test.directory.readProfile("self")).toMatchObject({ profile: { role: "maintainer" } });
  const merged = { ...changed, id: "merged" };
  loadSelf.mockResolvedValue(merged);
  test.publish({
    selfUser: { id: "merged", name: "Merged", identity: { type: "profile", id: "merged" } },
  });
  await test.directory.load();
  expect(test.directory.readProfile("self").status).toBe("denied");
  expect(test.directory.readProfile("merged")).toMatchObject({ profile: { id: "merged" } });
  const reads = loadSelf.mock.calls.length;
  test.publish({ hello: rosterHello([]) });
  expect(test.directory.readProfile("merged").status).toBe("denied");
  expect(loadSelf).toHaveBeenCalledTimes(reads);
});

it.each(["disconnect", "close", "reconnect"])(
  "retires a pending self read after %s",
  async (retirement) => {
    const stale = createDeferred<UserProfile | null>();
    const fresh = { ...photo, id: "self", role: "maintainer" };
    const loadSelf = vi
      .fn<ApplicationGateway["loadSelfProfile"]>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(fresh);
    const test = fixture(undefined, selfSnapshot(), undefined, loadSelf);
    const stop = test.directory.subscribe(vi.fn(), true);
    onTestFinished(stop);
    const old = test.directory.load();
    if (retirement === "close") {
      stop();
    } else {
      test.publish({ phase: "reconnecting" });
    }
    if (retirement === "reconnect") {
      test.publish({ phase: "connected" });
      await test.directory.load();
    }
    stale.resolve({ ...fresh, role: "guest" });
    await old;
    expect(test.directory.readProfile("self")).toEqual(
      retirement === "reconnect"
        ? { status: "ready", profile: fresh }
        : { status: retirement === "close" ? "unknown" : "disconnected" },
    );
  },
);
