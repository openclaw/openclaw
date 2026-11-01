/* @vitest-environment jsdom */
import { expect } from "vitest";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "./control-ui-team-scale-fixture.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

const controls = (window: Window & typeof globalThis) => {
  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  return gateway;
};

it("persists an acknowledged migration through reads and a document reload", async ({
  gatewayPage,
}) => {
  const { scenario } = createControlUiTeamScaleFixture({ now: 1_800_000_000_000 });
  const script = createControlUiMockGatewayInitScript(scenario);
  gatewayPage.execute(script);
  const first = gatewayPage.connect();
  await flushMockTimers();
  await first.request("hello", "connect", {});
  expect(await first.request("seed", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries: scenario.bootstrapPreferences?.entries,
  });
  expect(
    await first.request("migrate", "users.prefs.set", {
      entries: { "fixture.migration.v1": true },
      expectedEntries: { "fixture.migration.v1": null },
    }),
  ).toEqual({ status: "ok" });
  const eventIndex = first.frames.findIndex((frame) => frame.event === "users.prefs.changed");
  expect(eventIndex).toBeGreaterThan(first.frames.findIndex((frame) => frame.id === "migrate"));
  expect(first.frames[eventIndex]).toMatchObject({
    payload: {
      profileId: scenario.bootstrapPreferences?.profileId,
      keys: ["fixture.migration.v1"],
    },
  });
  expect(
    await first.request("read-after-write", "users.prefs.get", { keys: ["fixture.migration.v1"] }),
  ).toEqual({ status: "ok", entries: { "fixture.migration.v1": true } });

  controls(gatewayPage.window).closeLatest();
  // Reinstalling the serialized owner in the same storage partition models document reload.
  gatewayPage.execute(script);
  const reloaded = gatewayPage.connect();
  await flushMockTimers();
  await reloaded.request("hello", "connect", {});
  expect(
    await reloaded.request("read-after-reload", "users.prefs.get", {
      keys: ["fixture.migration.v1"],
    }),
  ).toEqual({ status: "ok", entries: { "fixture.migration.v1": true } });
  expect(
    await reloaded.request("stale-migration", "users.prefs.set", {
      entries: { "fixture.migration.v1": true },
      expectedEntries: { "fixture.migration.v1": null },
    }),
  ).toEqual({ status: "conflict" });
  expect(reloaded.frames.filter((frame) => frame.event === "users.prefs.changed")).toHaveLength(0);
  expect(
    await reloaded.request("remove", "users.prefs.set", {
      entries: { "fixture.migration.v1": null },
      expectedEntries: { "fixture.migration.v1": true },
    }),
  ).toEqual({ status: "ok" });
  expect(await reloaded.request("empty-projection", "users.prefs.get", { keys: [] })).toEqual({
    status: "ok",
    entries: {},
  });
  expect(
    await reloaded.request("removed", "users.prefs.get", { keys: ["fixture.migration.v1"] }),
  ).toEqual({ status: "ok", entries: {} });
});

it("isolates profiles and Gateway endpoints and publishes only to matching connections", async ({
  gatewayPage,
}) => {
  const hello = (instanceId: string, id: string) => ({
    match: { client: { instanceId } },
    response: { type: "hello-ok", snapshot: { presence: [{ instanceId, user: { id } }] } },
  });
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({
      methodResponses: {
        connect: {
          cases: [hello("alice", "alice"), hello("alice-peer", "alice"), hello("bob", "bob")],
        },
      },
      bootstrapPreferences: {
        profileId: "alice",
        entries: { "fixture.choice": { first: 1, second: 2 } },
      },
    }),
  );
  const alice = gatewayPage.connect("ws://first-gateway/socket");
  const peer = gatewayPage.connect("ws://first-gateway/socket?view=peer");
  const bob = gatewayPage.connect("ws://first-gateway/socket");
  const otherGateway = gatewayPage.connect("ws://other-gateway/socket");
  await flushMockTimers();
  await alice.request("a", "connect", { client: { instanceId: "alice" } });
  await peer.request("p", "connect", { client: { instanceId: "alice-peer" } });
  await bob.request("b", "connect", { client: { instanceId: "bob" } });
  await otherGateway.request("o", "connect", { client: { instanceId: "alice" } });
  expect(
    await alice.request("set", "users.prefs.set", {
      entries: { "fixture.choice": "saved" },
      expectedEntries: { "fixture.choice": { second: 2, first: 1 } },
    }),
  ).toEqual({ status: "ok" });
  expect(await peer.request("read", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries: { "fixture.choice": "saved" },
  });
  expect(await bob.request("read", "users.prefs.get", {})).toEqual({ status: "ok", entries: {} });
  expect(await otherGateway.request("read", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries: { "fixture.choice": { first: 1, second: 2 } },
  });
  for (const connection of [alice, peer]) {
    expect(connection.frames.filter((frame) => frame.event === "users.prefs.changed")).toEqual([
      expect.objectContaining({ payload: { profileId: "alice", keys: ["fixture.choice"] } }),
    ]);
  }
  for (const connection of [bob, otherGateway]) {
    expect(connection.frames.filter((frame) => frame.event === "users.prefs.changed")).toHaveLength(
      0,
    );
  }
});

it("commits only successful deferred writes and preserves explicitly scripted outcomes", async ({
  gatewayPage,
}) => {
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({
      presenceUsers: [{ id: "alice", self: true }],
      bootstrapPreferences: { profileId: "alice", entries: { "fixture.choice": "before" } },
    }),
  );
  const connection = gatewayPage.connect();
  const gateway = controls(gatewayPage.window);
  await flushMockTimers();
  await connection.request("hello", "connect", {});
  const entries = { "fixture.choice": "after" };
  gateway.deferNext("users.prefs.set");
  connection.send("rejected", "users.prefs.set", { entries });
  await flushMockTimers();
  gateway.rejectDeferred("users.prefs.set", {
    code: "UNAVAILABLE",
    message: "Fixture write failed",
  });
  expect(await connection.request("unchanged", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries: { "fixture.choice": "before" },
  });
  gateway.deferNext("users.prefs.set");
  connection.send("accepted", "users.prefs.set", {
    entries,
    expectedEntries: { "fixture.choice": "before" },
  });
  await flushMockTimers();
  expect(connection.frames.find((frame) => frame.id === "accepted")).toBeUndefined();
  gateway.resolveDeferred("users.prefs.set");
  expect(await connection.request("committed", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries,
  });
  const eventIndex = connection.frames.findIndex((frame) => frame.event === "users.prefs.changed");
  expect(eventIndex).toBeGreaterThan(
    connection.frames.findIndex((frame) => frame.id === "accepted"),
  );

  gateway.deferNext("users.prefs.get");
  connection.send("scripted-read-success", "users.prefs.get", {});
  await flushMockTimers();
  gateway.resolveDeferred("users.prefs.get", {
    status: "ok",
    entries: { "fixture.delayed": "scripted" },
  });
  expect(connection.frames.find((frame) => frame.id === "scripted-read-success")).toMatchObject({
    payload: { status: "ok", entries: { "fixture.delayed": "scripted" } },
  });

  gateway.deferNext("users.prefs.get");
  connection.send("typed-read-failure", "users.prefs.get", {});
  await flushMockTimers();
  gateway.resolveDeferred("users.prefs.get", { status: "no_durable_identity" });
  expect(connection.frames.find((frame) => frame.id === "typed-read-failure")).toMatchObject({
    payload: { status: "no_durable_identity" },
  });

  gateway.setMethodResponse("users.prefs.set", { status: "conflict" });
  expect(
    await connection.request("scripted-conflict", "users.prefs.set", {
      entries: { "fixture.choice": "rejected" },
    }),
  ).toEqual({ status: "conflict" });
  expect(await connection.request("still-committed", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries,
  });
  gateway.setMethodResponse("users.prefs.get", {
    status: "ok",
    entries: { "fixture.scripted": true },
  });
  expect(await connection.request("scripted-read", "users.prefs.get", {})).toEqual({
    status: "ok",
    entries: { "fixture.scripted": true },
  });
});
