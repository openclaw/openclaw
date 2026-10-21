import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayClient } from "../../packages/gateway-client/src/client.js";
import type { GatewayProtocolSocket } from "../../packages/gateway-client/src/protocol-client.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
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

type ProtocolHarness = {
  handleMessage(socket: GatewayProtocolSocket, generation: number, raw: string): void;
};

const clients: GatewayChatClient[] = [];
const legacyCreationError = {
  code: "INVALID_REQUEST",
  message: "invalid sessions.create params: unexpected property 'succeedsParent'",
};

function createFixture(delayWrites = false) {
  const replies: Array<(error?: { code: string; message: string }) => void> = [];
  const client = new GatewayChatClient({ url: "ws://tui-startup.invalid" });
  clients.push(client);
  const gateway = (client as unknown as { client: GatewayClient }).client;
  const protocol = (gateway as unknown as { protocol: ProtocolHarness }).protocol;
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
        protocol.handleMessage(
          socket,
          1,
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
  Object.assign(protocol, { socket, stopped: false, generation: 1 });
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
    const f = createFixture(true);
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

it("does not start a legacy creation retry after /abort", async () => {
  const f = createFixture(true);
  f.state.currentSessionId = "original-session";
  const originalKey = f.state.currentSessionKey;
  const operation = f.commands.handleCommand("/new");
  expect(f.writes).toHaveLength(1);
  await f.commands.handleCommand("/abort");
  f.finishWrite(legacyCreationError);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writes).toHaveLength(1);
  await operation;
  expect(f.state.currentSessionKey).toBe(originalKey);
});

it("keeps the original deadline and key through a legacy creation retry", async () => {
  const f = createFixture(true);
  f.state.currentSessionId = "original-session";
  const settled = vi.fn();
  const operation = f.commands.handleCommand("/new").then(settled);
  await vi.advanceTimersByTimeAsync(240_000);
  f.finishWrite(legacyCreationError);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writes).toHaveLength(2);
  const firstWrite = f.writes[0];
  assert(firstWrite);
  const key = (firstWrite.params as { key: string }).key;
  expect(f.writes.map((frame) => (frame.params as { key: string }).key)).toEqual([key, key]);
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS - 240_000);
  expect(settled).toHaveBeenCalledOnce();
  await operation;
});

it.each([
  ["send", 45_000],
  ["send", 240_000],
  ["new", 45_000],
  ["new", 240_000],
] as const)("%s waits through %i ms of startup and writes once", async (action, preparationMs) => {
  const f = createFixture();
  const settled = vi.fn();
  const operation = f.submit(action).then(settled);
  await vi.advanceTimersByTimeAsync(preparationMs);
  expect(settled).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
  f.ready();
  await vi.advanceTimersByTimeAsync(1_000);
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
  const f = createFixture();
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
