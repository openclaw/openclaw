/** @vitest-environment node */
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EarlyGateway, takeEarlyGatewaySubscription } from "./gateway-boot.ts";
import { useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { getLatestWebSocket, wsInstances } from "./gateway-socket.test-support.ts";
import type { GatewayHelloOk } from "./gateway.ts";

let nextRequestId = 0;
useHandshakeHarness({ randomUUID: () => `boot-request-${++nextRequestId}` });
const href = "http://127.0.0.1:18789/chat/main/test";
const key = "agent:main:test";
const options = { url: "ws://127.0.0.1:18789", token: "synthetic-token" };
const initialHistory = { limit: 80, knownState: {}, maxBytes: 262144, toolResultMaxChars: 2000 };
let boot: EarlyGateway;

beforeEach(() => {
  vi.stubGlobal("location", { href });
  boot = new EarlyGateway(options, key, initialHistory, href);
});
afterEach(() => boot.client.stop());

async function handshake() {
  const socket = getLatestWebSocket();
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "test-nonce", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  const connect = socket.sent
    .map((value) => JSON.parse(value))
    .find((frame) => frame.method === "connect");
  expect(connect).toBeDefined();
  expect(socket.sent.map((value) => JSON.parse(value).method)).toEqual(["connect"]);
  return { socket, connect };
}

async function acceptHello(
  { socket, connect }: Awaited<ReturnType<typeof handshake>>,
  auth?: GatewayHelloOk["auth"],
) {
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: { type: "hello-ok", protocol: PROTOCOL_VERSION, ...(auth ? { auth } : {}) },
  });
  await vi.advanceTimersByTimeAsync(0);
  const subscription = socket.sent
    .map((value) => JSON.parse(value))
    .find((frame) => frame.method === "sessions.messages.subscribe");
  expect(subscription).toBeDefined();
  return subscription;
}

it("hands off one connection, initial history, and ordered events without loss or duplication", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const subscription = await acceptHello(connection);
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 1, seq: 1 });
  socket.emitMessage({
    type: "res",
    id: subscription.id,
    ok: true,
    payload: { key, initialHistory: { ok: true, payload: { messages: ["snapshot"] } } },
  });
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 2, seq: 2 });
  await vi.advanceTimersByTimeAsync(0);

  const delivery: unknown[] = [];
  const client = boot.adopt({
    ...options,
    onHello: () => delivery.push("hello"),
    onEvent: (event) => delivery.push(event.payload),
  });
  expect(client).toBe(boot.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(delivery).toEqual(["hello"]);
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 3, seq: 3 });
  const acquired = await takeEarlyGatewaySubscription(boot.client, key, { initialHistory });
  expect(acquired?.initialHistory).toEqual({ ok: true, payload: { messages: ["snapshot"] } });
  await vi.advanceTimersByTimeAsync(0);
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 4, seq: 4 });
  expect(delivery).toEqual(["hello", 1, 2, 3, 4]);
  expect(wsInstances).toHaveLength(1);
  expect(
    socket.sent
      .map((value) => JSON.parse(value).method)
      .filter((method) => method === "sessions.messages.subscribe"),
  ).toHaveLength(1);
  expect(takeEarlyGatewaySubscription(boot.client, key, { initialHistory })).toBeUndefined();
});

it("keeps live delivery when the pane needs a different initial history request", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const subscribe = await acceptHello(connection);
  socket.emitMessage({
    type: "res",
    id: subscribe.id,
    ok: true,
    payload: { key, initialHistory: { ok: true, payload: { messages: ["old snapshot"] } } },
  });
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 1, seq: 1 });
  await vi.advanceTimersByTimeAsync(0);
  const onEvent = vi.fn();
  expect(boot.adopt({ ...options, onEvent })).toBe(boot.client);
  const subscription = await takeEarlyGatewaySubscription(boot.client, key, {
    initialHistory: { ...initialHistory, inputRunIds: ["pending-input"] },
  });
  expect(subscription).not.toHaveProperty("initialHistory");
  await vi.advanceTimersByTimeAsync(0);
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 2, seq: 2 });
  expect(onEvent.mock.calls.map(([event]) => event.payload)).toEqual([1, 2]);
  expect(socket.readyState).toBe(1);
  expect(wsInstances).toHaveLength(1);
});

it("prepares authorized approval replay on the same observer before the pane attaches", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const request = (method: string) =>
    socket.sent.map((value) => JSON.parse(value)).filter((frame) => frame.method === method);
  const initial = await acceptHello(connection, {
    role: "operator",
    scopes: ["operator.approvals"],
  });
  socket.emitMessage({
    type: "res",
    id: initial.id,
    ok: true,
    payload: {
      key,
      initialHistory: { ok: true, payload: { messages: ["snapshot"] } },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const replay = request("sessions.messages.subscribe")[1];
  expect(replay.params).toMatchObject({
    includeApprovals: true,
    subscriptionId: initial.params.subscriptionId,
  });
  socket.emitMessage({
    type: "res",
    id: replay.id,
    ok: true,
    payload: {
      key,
      approvalReplay: { exec: ["pending-approval"] },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(boot.adopt(options)).toBe(boot.client);
  const result = await takeEarlyGatewaySubscription(boot.client, key, {
    initialHistory,
    includeApprovals: true,
  });
  expect(result).toMatchObject({
    initialHistory: { ok: true, payload: { messages: ["snapshot"] } },
    includeApprovals: true,
    approvalReplay: { exec: ["pending-approval"] },
  });
  expect(request("sessions.messages.subscribe")).toHaveLength(2);
  expect(request("sessions.messages.unsubscribe")).toHaveLength(0);
});

it("leaves the foreground handoff available to unrelated narration consumers", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const initial = await acceptHello(connection);
  expect(boot.adopt(options)).toBe(boot.client);
  expect(
    await takeEarlyGatewaySubscription(boot.client, "agent:main:other", { mode: "narration" }),
  ).toBeNull();
  expect(await takeEarlyGatewaySubscription(boot.client, key, { mode: "narration" })).toBeNull();
  socket.emitMessage({
    type: "res",
    id: initial.id,
    ok: true,
    payload: { key, initialHistory: { ok: true, payload: { messages: ["snapshot"] } } },
  });
  const result = await takeEarlyGatewaySubscription(boot.client, key, { initialHistory });
  expect(result?.initialHistory).toEqual({ ok: true, payload: { messages: ["snapshot"] } });
  expect(wsInstances).toHaveLength(1);
});

it("counts approval replay against the retained byte bound", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const request = () =>
    socket.sent
      .map((value) => JSON.parse(value))
      .findLast((frame) => frame.method === "sessions.messages.subscribe");
  await acceptHello(connection, {
    role: "operator",
    scopes: ["operator.approvals"],
  });
  socket.emitMessage({
    type: "res",
    id: request().id,
    ok: true,
    payload: { key, initialHistory: { ok: true, payload: { messages: [] } } },
  });
  await vi.advanceTimersByTimeAsync(0);
  socket.emitMessage({
    type: "res",
    id: request().id,
    ok: true,
    payload: { key, approvalReplay: { oversized: "x".repeat(1024 * 1024) } },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(boot.adopt(options)).toBeNull();
  expect(socket.readyState).toBe(3);
});

it.each(["route", "timeout", "overflow"])(
  "retires the early socket on %s before normal startup adopts it",
  async (reason) => {
    const { socket, connect } = await handshake();
    if (reason === "route") {
      vi.stubGlobal("location", { href: `${href}-other` });
    } else if (reason === "timeout") {
      await vi.advanceTimersByTimeAsync(10_000);
    } else {
      socket.emitMessage({
        type: "res",
        id: connect.id,
        ok: true,
        payload: { type: "hello-ok", protocol: PROTOCOL_VERSION },
      });
      for (let index = 1; index <= 257; index++) {
        socket.emitMessage({ type: "event", event: "boot-proof", payload: index, seq: index });
      }
    }
    expect(boot.adopt(options)).toBeNull();
    expect(socket.readyState).toBe(3);
  },
);

it("hands rejected authentication to the login owner without repeating connect", async () => {
  const { socket, connect } = await handshake();
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: false,
    error: { code: "UNAUTHORIZED", message: "rejected", details: { code: "AUTH_TOKEN_MISMATCH" } },
  });
  await vi.advanceTimersByTimeAsync(0);
  const onHello = vi.fn();
  const onClose = vi.fn();
  expect(boot.adopt({ ...options, onHello, onClose })).toBe(boot.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(onHello).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ code: "UNAUTHORIZED" }) }),
  );
  expect(wsInstances).toHaveLength(1);
  expect(socket.readyState).toBe(3);
});

it.each([false, true])(
  "preserves retryable admission before attachment (retry first: %s)",
  async (retryFirst) => {
    const { socket, connect } = await handshake();
    socket.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "temporarily unavailable", retryable: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    const onHello = vi.fn();
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const attach = async () => {
      expect(boot.adopt({ ...options, onHello, onClose, onEvent })).toBe(boot.client);
      await vi.advanceTimersByTimeAsync(0);
    };
    if (!retryFirst) {
      await attach();
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({
          willRetry: true,
          error: expect.objectContaining({ code: "UNAVAILABLE" }),
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wsInstances).toHaveLength(2);
    const retry = await handshake();
    retry.socket.emitMessage({
      type: "res",
      id: retry.connect.id,
      ok: true,
      payload: { type: "hello-ok", protocol: PROTOCOL_VERSION },
    });
    retry.socket.emitMessage({ type: "event", event: "boot-proof", payload: "retry", seq: 1 });
    await vi.advanceTimersByTimeAsync(0);
    if (retryFirst) {
      await attach();
      expect(onClose).not.toHaveBeenCalled();
    }
    expect(onHello).toHaveBeenCalledOnce();
    expect(await takeEarlyGatewaySubscription(boot.client, key, { initialHistory })).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: "retry" }));
  },
);

it("drops buffered events on reconnect and leaves recovery with the protocol owner", async () => {
  const { socket, connect } = await handshake();
  socket.emitMessage({
    type: "res",
    id: connect.id,
    ok: true,
    payload: { type: "hello-ok", protocol: PROTOCOL_VERSION },
  });
  socket.emitMessage({ type: "event", event: "boot-proof", payload: "retired", seq: 1 });
  const onEvent = vi.fn();
  const onClose = vi.fn();
  expect(boot.adopt({ ...options, onEvent, onClose })).toBe(boot.client);
  socket.emitClose(1006, "restart");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onEvent).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(2);
  expect(takeEarlyGatewaySubscription(boot.client, key, { initialHistory })).toBeUndefined();
});

it("abandons a transient pre-attach disconnect for normal startup", async () => {
  const { socket } = await handshake();
  socket.emitClose(1006, "restart");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(boot.adopt(options)).toBeNull();
  expect(wsInstances).toHaveLength(1);
});

it("delivers a rejected early subscription to the existing read-retry owner", async () => {
  const connection = await handshake();
  const { socket } = connection;
  const subscribe = await acceptHello(connection);
  const error = {
    code: "INVALID_REQUEST",
    message: "session changed",
    details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" },
  };
  socket.emitMessage({ type: "res", id: subscribe.id, ok: false, error });
  socket.emitMessage({ type: "event", event: "boot-proof", payload: 1, seq: 1 });
  await vi.advanceTimersByTimeAsync(0);
  const onEvent = vi.fn();
  expect(boot.adopt({ ...options, onEvent })).toBe(boot.client);
  await expect(
    takeEarlyGatewaySubscription(boot.client, key, { initialHistory }),
  ).rejects.toMatchObject({ gatewayCode: error.code, details: error.details });
  await vi.advanceTimersByTimeAsync(0);
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: 1 }));
  expect(wsInstances).toHaveLength(1);
  expect(takeEarlyGatewaySubscription(boot.client, key, { initialHistory })).toBeUndefined();
});
