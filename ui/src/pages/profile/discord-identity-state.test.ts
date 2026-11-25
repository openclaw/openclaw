import { afterEach, expect, it, vi } from "vitest";
import type { UsersChannelIdentityResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { DiscordIdentityState } from "./discord-identity-state.ts";

const states: DiscordIdentityState[] = [];
afterEach(() => {
  for (const owner of states.splice(0)) {
    owner.dispose();
  }
});

function snapshot(
  request: Parameters<typeof createTestGatewayClient>[0],
  profileId = "alice",
  scopes = ["operator.sessions.read"],
) {
  return createApplicationGatewaySnapshot({
    client: createTestGatewayClient(request),
    phase: "connected",
    selfUser: { id: profileId },
    hello: gatewayHelloForMethods(["users.channelIdentity"], scopes),
  });
}

function state() {
  const owner = new DiscordIdentityState(vi.fn());
  states.push(owner);
  return owner;
}

const accounts = [
  { accountId: "default", available: false, senderIds: [] },
  { accountId: "community", available: true, senderIds: [] },
];

it("selects an available account on initial profile load instead of the unavailable default", async () => {
  const request = vi.fn(async () => ({ status: "ready", accounts }));
  const owner = state();
  owner.sync(snapshot(request));
  await vi.waitFor(() => expect(owner.loading).toBe(false));

  expect(owner.accountId).toBe("community");
  expect(owner.selected?.available).toBe(true);
  expect(request).toHaveBeenCalledExactlyOnceWith("users.channelIdentity", {
    action: "status",
    channelId: "discord",
  });
});

it("presents an existing link before an unlinked available account on initial load", async () => {
  const linked = { ...accounts[0]!, senderIds: ["alice-discord"] };
  const request = vi.fn(async () => ({ status: "ready", accounts: [accounts[1]!, linked] }));
  const owner = state();
  owner.sync(snapshot(request));
  await vi.waitFor(() => expect(owner.loading).toBe(false));

  expect(owner.selected).toEqual(linked);
  await owner.connect();
  expect(request).toHaveBeenCalledTimes(1);
  await owner.mutate("disconnect");
  expect(request).toHaveBeenCalledWith("users.channelIdentity", {
    action: "disconnect",
    channelId: "discord",
    accountId: "default",
  });
});

it("preserves an explicit account choice on refresh, even when that account is unavailable", async () => {
  const request = vi.fn(async () => ({ status: "ready", accounts }));
  const owner = state();
  owner.sync(snapshot(request));
  await vi.waitFor(() => expect(owner.loading).toBe(false));

  owner.accountId = "default";
  await owner.load();
  expect(owner.accountId).toBe("default");
  await owner.connect();
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains an explicit unlinked account even when another account has an existing link", async () => {
  const request = vi.fn(async () => ({
    status: "ready",
    accounts: [{ ...accounts[0]!, senderIds: ["alice-discord"] }, accounts[1]!],
  }));
  const owner = state();
  owner.sync(snapshot(request));
  await vi.waitFor(() => expect(owner.loading).toBe(false));
  owner.accountId = "community";
  await owner.load();
  expect(owner.accountId).toBe("community");
});

it("selects a remaining available account when the previous choice is no longer returned", async () => {
  const request = vi.fn(async () => ({ status: "ready", accounts }));
  const owner = state();
  owner.sync(snapshot(request));
  await vi.waitFor(() => expect(owner.loading).toBe(false));

  owner.accountId = "removed";
  await owner.load();
  expect(owner.accountId).toBe("community");
});

it("does not reuse another profile's selection or late account response", async () => {
  const alice = createDeferred<UsersChannelIdentityResult>();
  const owner = state();
  owner.sync(snapshot(() => alice.promise));
  owner.sync(
    snapshot(
      async () => ({
        status: "ready",
        accounts: [{ accountId: "bob-account", available: true, senderIds: ["bob-id"] }],
      }),
      "bob",
    ),
  );
  await vi.waitFor(() => expect(owner.loading).toBe(false));
  alice.resolve({ status: "ready", accounts });
  await alice.promise;
  expect(owner.accountId).toBe("bob-account");
  expect(owner.accounts).toEqual([
    { accountId: "bob-account", available: true, senderIds: ["bob-id"] },
  ]);
});

it("does not request account information without existing self-read access", async () => {
  const request = vi.fn();
  const owner = state();
  owner.sync(snapshot(request, "alice", []));
  expect(owner.available).toBe(false);
  expect(owner.accounts).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});
