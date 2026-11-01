/* @vitest-environment jsdom */
import { expect } from "vitest";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import {
  flushMockTimers as flush,
  mockGatewayTest as it,
} from "./mock-gateway-page.test-support.ts";

const ids = (items: readonly { id?: string }[]) => items.map(({ id }) => id);
function expectReply(frames: readonly unknown[], id: string, payload?: unknown) {
  const result = { id, ok: true };
  expect(frames.at(-1)).toMatchObject(payload === undefined ? result : { ...result, payload });
}

it.for(["resolve", "reject"] as const)(
  "%ss every held request without changing one-shot deferrals",
  async (outcome, { gatewayPage }) => {
    const { window, execute, responses: frames } = gatewayPage;
    const catalog = { environments: [], profiles: [{ id: "aws" }] };
    const scenario = {
      heldMethods: ["environments.list"],
      deferredMethods: ["models.list"],
      methodResponses: { "environments.list": catalog },
    };
    execute(createControlUiMockGatewayInitScript(scenario));
    const sockets = [
      gatewayPage.connect("ws://mock-gateway/first"),
      gatewayPage.connect("ws://mock-gateway/second"),
    ] as const;
    const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Mock Gateway was not installed");
    }
    await flush();
    sockets[0].send("catalog-first", "environments.list");
    sockets[1].send("catalog-replacement", "environments.list");
    sockets[0].send("model-held", "models.list");
    sockets[0].send("model-next", "models.list");
    await flush();
    expect(ids(frames)).toEqual(["model-next"]);

    if (outcome === "resolve") {
      gateway.resolveDeferred("environments.list");
    } else {
      gateway.rejectDeferred("environments.list", { message: "catalog unavailable" });
    }
    const released =
      outcome === "resolve"
        ? { ok: true, payload: catalog }
        : { ok: false, error: expect.objectContaining({ message: "catalog unavailable" }) };
    expect(frames.slice(1)).toEqual(
      ["catalog-first", "catalog-replacement"].map((id) =>
        expect.objectContaining({ id, ...released }),
      ),
    );
    sockets[1].send("catalog-after-release", "environments.list");
    await flush();
    expectReply(frames, "catalog-after-release", catalog);
    gateway.resolveDeferred("models.list");
    expectReply(frames, "model-held");

    gateway.deferNext("environments.list");
    sockets[0].send("catalog-one-shot", "environments.list");
    sockets[0].send("catalog-unblocked", "environments.list");
    await flush();
    expectReply(frames, "catalog-unblocked");
    expect(frames.some((frame) => frame.id === "catalog-one-shot")).toBe(false);
    gateway.resolveDeferred("environments.list");
    expectReply(frames, "catalog-one-shot");
  },
);

it("keeps roster deferrals separate from child queries", async ({ gatewayPage }) => {
  const { window, execute, responses: frames } = gatewayPage;
  execute(createControlUiMockGatewayInitScript());
  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  const { send } = gatewayPage.connect("ws://mock-gateway/roster");
  await flush();

  const rosterMatch = { includeGlobal: true };
  const childQuery = { includeGlobal: false, spawnedBy: "agent:main:parent" };
  expect(gateway.deferNext("sessions.list", rosterMatch)).toBe(0);
  send("child-before", "sessions.list", childQuery);
  send("roster-held", "sessions.list", rosterMatch);
  send("child-after", "sessions.list", childQuery);
  send("health", "health", {});
  await flush();

  expect(ids(frames)).toEqual(["child-before", "child-after", "health"]);
  expect(ids(gateway.findRequests("sessions.list", rosterMatch))).toEqual(["roster-held"]);
  expect(ids(gateway.findRequests("sessions.list"))).toEqual([
    "child-before",
    "roster-held",
    "child-after",
  ]);
  expect(gateway.findRequests()).toHaveLength(4);

  gateway.resolveDeferred("sessions.list");
  expectReply(frames, "roster-held");
  send("roster-next", "sessions.list", rosterMatch);
  await flush();
  expectReply(frames, "roster-next");
  const rosterRequests = gateway.findRequests("sessions.list", rosterMatch);
  expect(ids(rosterRequests)).toEqual(["roster-held", "roster-next"]);
  expect(gateway.deferNext("sessions.list", rosterMatch)).toBe(rosterRequests.length);
});

it.for(["resolve", "reject"] as const)(
  "%ss startup held inside the subscription response without a second wire request",
  async (outcome, { gatewayPage }) => {
    const messages = [{ role: "assistant", content: "Live witness" }];
    gatewayPage.execute(
      createControlUiMockGatewayInitScript({
        deferredMethods: ["chat.startup"],
        historyMessages: messages,
      }),
    );
    const { send, frames } = gatewayPage.connect();
    const gateway = (gatewayPage.window as MockGatewayWindow).openclawControlUiE2eGateway!;
    await flush();
    send("subscription", "sessions.messages.subscribe", {
      key: "agent:main:main",
      initialHistory: {},
    });
    await flush();
    expect(frames.filter((frame) => frame.type === "res")).toEqual([]);
    expect(gateway.findRequests("chat.startup")).toEqual([]);
    expect(gateway.findRequests("sessions.messages.subscribe")).toHaveLength(1);

    if (outcome === "resolve") {
      gateway.resolveDeferred("chat.startup");
    } else {
      gateway.rejectDeferred("chat.startup", { message: "History unavailable" });
    }
    expectReply(frames, "subscription", {
      key: "agent:main:main",
      initialHistory:
        outcome === "resolve"
          ? { ok: true, payload: expect.objectContaining({ messages }) }
          : { ok: false, error: expect.objectContaining({ message: "History unavailable" }) },
    });
  },
);

it("preserves explicitly supplied deferred subscription payloads", async ({ gatewayPage }) => {
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({
      heldMethods: ["chat.startup"],
    }),
  );
  const { send, frames } = gatewayPage.connect();
  const gateway = (gatewayPage.window as MockGatewayWindow).openclawControlUiE2eGateway!;
  await flush();
  const key = "agent:main:main";
  const payloads = [
    { key },
    { key, initialHistory: { ok: true, payload: { messages: ["Explicit history"] } } },
  ];
  for (const [index, payload] of payloads.entries()) {
    const id = `explicit-${index}`;
    gateway.deferNext("sessions.messages.subscribe");
    send(id, "sessions.messages.subscribe", { key, initialHistory: {} });
    await flush();
    gateway.resolveDeferred("sessions.messages.subscribe", payload);
    expect(frames.at(-1)).toMatchObject({ id, ok: true });
    expect(frames.at(-1)?.payload).toEqual(payload);
  }
});

it("replaces the static startup and history transcript together", async ({ gatewayPage }) => {
  const stale = { messages: [{ role: "assistant", content: "Saved witness" }], hasMore: false };
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({
      methodResponses: { "chat.startup": stale, "chat.history": stale },
    }),
  );
  const { request } = gatewayPage.connect();
  const gateway = (gatewayPage.window as MockGatewayWindow).openclawControlUiE2eGateway!;
  await flush();
  const messages = [{ role: "assistant", content: "Live witness" }];
  gateway.setHistoryMessages(messages);
  for (const method of ["chat.startup", "chat.history"]) {
    expect(await request(method, method, { sessionKey: "agent:main:main" })).toEqual({
      messages,
      hasMore: false,
    });
  }
  expect(
    await request("subscription", "sessions.messages.subscribe", {
      key: "agent:main:main",
      initialHistory: {},
    }),
  ).toEqual({
    key: "agent:main:main",
    initialHistory: { ok: true, payload: { messages, hasMore: false } },
  });
});
