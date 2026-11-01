import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClient } from "../../packages/gateway-client/src/client.js";
import {
  GatewayProtocolClient,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "../../packages/gateway-client/src/protocol-client.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { GatewayChatRequests } from "./gateway-chat-requests.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import {
  createBaseState,
  createTestSessionActions,
  makeChatLog,
  makeTui,
} from "./tui-session-actions-test-support.js";

// Keep the real protocol/deadline owner without host SSH or device-auth preparation.
vi.mock("../gateway/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/client.js")>()),
  GatewayClient: (await import("../../packages/gateway-client/src/client.js")).GatewayClient,
}));

const clients: GatewayChatClient[] = [];
const legacyCreationError = {
  code: "INVALID_REQUEST",
  message: "invalid sessions.create params: unexpected property 'succeedsParent'",
};

async function createFixture(delayWrites = false) {
  const replies: Array<(error?: { code: string; message: string }) => void> = [];
  const client = new GatewayChatClient({ url: "ws://tui-startup.invalid" });
  clients.push(client);
  const gateway = (client as unknown as { client: GatewayClient }).client;
  let handlers: GatewayProtocolSocketHandlers | undefined;
  const protocol = new GatewayProtocolClient({
    createSocket: (next) => {
      handlers = next;
      return socket;
    },
    createRequestId: () => "tui-request",
    createRequestError: (error) => new GatewayClientRequestError(error),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  let ready = delayWrites;
  const attempts: string[] = [];
  const writes: RequestFrame[] = [];
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    close: () => {},
    send: (raw) => {
      const req = JSON.parse(raw) as RequestFrame;
      const params = req.params as Record<string, unknown>;
      const write = req.method === "chat.send" || req.method === "sessions.create";
      if (write) {
        attempts.push(raw);
        if (ready) {
          writes.push(req);
        }
      }
      const payloads = new Map<string, () => unknown>([
        ["connect", () => ({ type: "hello-ok" })],
        [
          "sessions.create",
          () => {
            assert(typeof params.key === "string");
            return { ok: true, key: `agent:main:${params.key}` };
          },
        ],
        ["chat.send", () => ({ runId: params.idempotencyKey })],
        ["chat.abort", () => ({ ok: true, aborted: false })],
        [
          "sessions.describe",
          () => ({ session: { key: params.key, sessionId: "fixture-session" }, defaults: {} }),
        ],
        ["sessions.list", () => ({ ts: 0, path: "", count: 0, sessions: [], defaults: {} })],
      ]);
      const payload = payloads.get(req.method)?.() ?? {
        messages: [],
        sessionInfo: { hasActiveRun: false },
      };
      const startupError =
        write && !ready
          ? {
              code: "UNAVAILABLE",
              message: "Agent is preparing",
              retryable: true,
              retryAfterMs: 1_000,
              details: { reason: "startup-sidecars", method: req.method },
            }
          : undefined;
      const reply = (error: { code: string; message: string } | undefined = startupError) =>
        handlers?.message(
          JSON.stringify({
            type: "res",
            id: req.id,
            ok: !error,
            ...(error ? { error } : { payload }),
          }),
        );
      if (write && ready && delayWrites) {
        replies.push(reply);
      } else {
        reply();
      }
    },
  };
  Object.assign(gateway, { protocol });
  protocol.start();
  assert(handlers);
  handlers.open();
  handlers.message(
    JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(protocol.connecting).toBe(false);
  const state = createBaseState({ historyLoaded: true });
  const chatLog = makeChatLog({ addSystem: vi.fn() });
  const tui = makeTui();
  const setActivityStatus = (value: string) => {
    state.activityStatus = value;
  };
  const context = { client, state, chatLog, tui, setActivityStatus };
  const actions = createTestSessionActions(context);
  const commands = createCommandHandlers({
    ...context,
    ...actions,
    opts: {},
    deliverDefault: false,
    openOverlay: (component) => tui.showOverlay(component),
    closeOverlay: () => tui.hideOverlay(),
    requestExit: vi.fn(),
  });
  return {
    state,
    chatLog,
    finishWrite: (error?: { code: string; message: string }) => {
      const reply = replies.shift();
      assert(reply, "expected a dispatched write");
      reply(error);
    },
    attempts,
    writes,
    actions,
    commands,
    submit: (action: "new" | "send") =>
      action === "new"
        ? commands.handleCommand("/new")
        : commands.sendMessage("Synthetic startup request"),
    ready: () => {
      ready = true;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  vi.useRealTimers();
});

it.each([
  ["new", "/stop"],
  ["send", "/abort"],
] as const)(
  "retains a dispatched %s through %s and a repeated submit",
  async (action, stopCommand) => {
    const f = await createFixture(true);
    const submit = () => f.submit(action);
    const settled = vi.fn();
    const operation = submit().then(settled);
    expect(f.writes).toHaveLength(1);
    const firstWrite = f.writes[0];
    assert(firstWrite);
    await f.commands.handleCommand(stopCommand);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(f.state.activityStatus).not.toBe("aborted");
    expect(f.chatLog.addSystem.mock.calls.flat().join("\n")).not.toContain(
      "session change in progress",
    );
    await submit();
    expect(f.writes).toEqual([firstWrite]);
    f.finishWrite();
    await operation;
    const params = firstWrite.params as { key?: string; idempotencyKey?: string };
    if (action === "new") {
      expect(f.state.currentSessionKey).toBe(`agent:main:${params.key}`);
    } else {
      expect(f.state.pendingSubmit).toMatchObject({
        phase: "accepted",
        runId: params.idempotencyKey,
      });
    }
    expect(f.chatLog.addSystem.mock.calls.flat().join("\n")).not.toMatch(
      /(?:new session|send) (?:canceled|failed)/,
    );
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(f.writes).toEqual([firstWrite]);
  },
);

it.each([false, true])("fences legacy creation retries (aborted=%s)", async (aborted) => {
  const f = await createFixture(true);
  f.state.currentSessionId = "original-session";
  const originalKey = f.state.currentSessionKey;
  const settled = vi.fn();
  const operation = f.commands.handleCommand("/new").then(settled);
  expect(f.writes).toHaveLength(1);
  if (aborted) {
    await f.commands.handleCommand("/abort");
  } else {
    await vi.advanceTimersByTimeAsync(240_000);
  }
  f.finishWrite(legacyCreationError);
  await vi.advanceTimersByTimeAsync(0);
  if (aborted) {
    expect(f.writes).toHaveLength(1);
    await operation;
    expect(f.state.currentSessionKey).toBe(originalKey);
  } else {
    expect(f.writes).toHaveLength(2);
    const keys = f.writes.map((frame) => (frame.params as { key: string }).key);
    expect(keys).toEqual([keys[0], keys[0]]);
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS - 240_000);
  }
  expect(settled).toHaveBeenCalledOnce();
  await operation;
});

it.each(["send", "new"] as const)("%s waits through startup and writes once", async (action) => {
  const f = await createFixture();
  const settled = vi.fn();
  const operation = f.submit(action).then(settled);
  await vi.advanceTimersByTimeAsync(240_000);
  expect(settled).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
  f.ready();
  await vi.advanceTimersToNextTimerAsync();
  await operation;
  expect(f.writes).toHaveLength(1);
  expect(new Set(f.attempts).size).toBe(1);
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  expect(f.writes).toHaveLength(1);
});

it.each([
  ["send", "/stop"],
  ["new", "/abort"],
  ["send", "navigation"],
  ["new", "navigation"],
] as const)("pending %s is canceled by %s", async (action, stopCommand) => {
  const f = await createFixture();
  const operation = f.submit(action);
  await vi.advanceTimersByTimeAsync(35_000);
  if (stopCommand === "navigation") {
    await f.actions.setSession("agent:main:other");
    await operation;
  } else {
    await f.commands.handleCommand(stopCommand);
  }
  f.ready();
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  await operation;
  expect(f.writes).toHaveLength(0);
  if (stopCommand === "navigation") {
    expect(f.state.currentSessionKey).toBe("agent:main:other");
  } else {
    expect(f.state.pendingSubmit).toBeNull();
  }
});

it("keeps the startup admission budget when the wall clock rewinds", async () => {
  const client = new GatewayClient({ url: "ws://tui-startup.invalid" });
  const requestSpy = vi.spyOn(client, "request").mockResolvedValue({});
  const requests = new GatewayChatRequests(client);
  await requests.write({ sessionKey: "agent:main:main" }, async (request) => {
    vi.setSystemTime(Date.now() - 90_000);
    await vi.advanceTimersByTimeAsync(500);
    return request("chat.send", {});
  });
  expect(requestSpy).toHaveBeenCalledWith(
    "chat.send",
    {},
    expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS - 500 }),
  );
});

it("retries chat.history when the wall clock jumps forward", async () => {
  const client = new GatewayClient({ url: "ws://tui-startup.invalid" });
  const requestSpy = vi
    .spyOn(client, "request")
    .mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Agent is preparing",
        retryable: true,
        retryAfterMs: 100,
        details: { method: "chat.history" },
      }),
    )
    .mockResolvedValue({ messages: [] });
  const requests = new GatewayChatRequests(client);
  const history = requests
    .loadHistory({ sessionKey: "agent:main:main" })
    .catch((error: unknown) => error);
  vi.setSystemTime(Date.now() + 120_000);
  await vi.advanceTimersByTimeAsync(100);
  expect(await history).toEqual({ messages: [] });
  expect(requestSpy).toHaveBeenCalledTimes(2);
});
