import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  socket: GatewayProtocolSocket;
  stopped: boolean;
  generation: number;
  handleMessage(socket: GatewayProtocolSocket, generation: number, raw: string): void;
};

const clients: GatewayChatClient[] = [];

function createFixture(delayWrites = false) {
  const replies: Array<(error?: { code: string; message: string }) => void> = [];
  const client = new GatewayChatClient({ url: "ws://tui-startup.invalid" });
  clients.push(client);
  const gateway = (client as unknown as { client: GatewayClient }).client;
  const protocol = (gateway as unknown as { protocol: ProtocolHarness }).protocol;
  let ready = false;
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
      let payload: unknown;
      switch (req.method) {
        case "sessions.create":
          assert(typeof params.key === "string");
          payload = { ok: true, key: `agent:main:${params.key}` };
          break;
        case "chat.send":
          payload = { runId: params.idempotencyKey };
          break;
        case "chat.abort":
          payload = { ok: true, aborted: false };
          break;
        case "sessions.describe":
          payload = { session: { key: params.key, sessionId: "fixture-session" }, defaults: {} };
          break;
        case "sessions.list":
          payload = { ts: 0, path: "", count: 0, sessions: [], defaults: {} };
          break;
        default:
          payload = { messages: [], sessionInfo: { hasActiveRun: false } };
      }
      const reply = (error?: { code: string; message: string }) =>
        protocol.handleMessage(
          socket,
          1,
          JSON.stringify({
            type: "res",
            id: req.id,
            ok: !error && (!write || ready),
            ...(error
              ? { error }
              : write && !ready
                ? {
                    error: {
                      code: "UNAVAILABLE",
                      message: "Agent is preparing",
                      retryable: true,
                      retryAfterMs: 1_000,
                      details: { reason: "startup-sidecars", method: req.method },
                    },
                  }
                : { payload }),
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
  const actions = createTestSessionActions({ client, state, chatLog, tui, setActivityStatus });
  const commands = createCommandHandlers({
    client,
    state,
    chatLog,
    tui,
    setActivityStatus,
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

describe("TUI startup admission", () => {
  it.each([
    ["new", "/stop"],
    ["send", "/abort"],
  ] as const)(
    "retains a dispatched %s through %s and a repeated submit",
    async (action, stopCommand) => {
      const fixture = createFixture(true);
      fixture.ready();
      const submit = () =>
        action === "new"
          ? fixture.commands.handleCommand("/new")
          : fixture.commands.sendMessage("Synthetic retained request");
      let settled = false;
      const operation = submit().then(() => {
        settled = true;
      });
      expect(fixture.writes).toHaveLength(1);
      const firstWrite = fixture.writes[0];
      assert(firstWrite);
      await fixture.commands.handleCommand(stopCommand);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(fixture.state.activityStatus).not.toBe("aborted");
      expect(fixture.chatLog.addSystem.mock.calls.flat()).not.toEqual(
        expect.arrayContaining([expect.stringContaining("session change in progress")]),
      );
      await submit();
      expect(fixture.writes).toEqual([firstWrite]);
      fixture.finishWrite();
      await operation;
      const params = firstWrite.params as { key?: string; idempotencyKey?: string };
      if (action === "new") {
        expect(fixture.state.currentSessionKey).toBe(`agent:main:${params.key}`);
      } else {
        expect(fixture.state.pendingSubmit).toMatchObject({
          phase: "accepted",
          runId: params.idempotencyKey,
        });
      }
      expect(fixture.chatLog.addSystem.mock.calls.flat()).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/(?:new session|send) (?:canceled|failed)/)]),
      );
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(fixture.writes).toEqual([firstWrite]);
    },
  );

  it("does not start a legacy creation retry after /abort", async () => {
    const fixture = createFixture(true);
    fixture.ready();
    fixture.state.currentSessionId = "original-session";
    const originalKey = fixture.state.currentSessionKey;
    const operation = fixture.commands.handleCommand("/new");
    expect(fixture.writes).toHaveLength(1);
    await fixture.commands.handleCommand("/abort");
    fixture.finishWrite({
      code: "INVALID_REQUEST",
      message: "invalid sessions.create params: unexpected property 'succeedsParent'",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.writes).toHaveLength(1);
    await operation;
    expect(fixture.state.currentSessionKey).toBe(originalKey);
  });

  it("keeps the original deadline and key through a legacy creation retry", async () => {
    const fixture = createFixture(true);
    fixture.ready();
    fixture.state.currentSessionId = "original-session";
    let settled = false;
    const operation = fixture.commands.handleCommand("/new").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(240_000);
    fixture.finishWrite({
      code: "INVALID_REQUEST",
      message: "invalid sessions.create params: unexpected property 'succeedsParent'",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.writes).toHaveLength(2);
    const firstWrite = fixture.writes[0];
    assert(firstWrite);
    expect(fixture.writes.map((frame) => (frame.params as { key: string }).key)).toEqual([
      (firstWrite.params as { key: string }).key,
      (firstWrite.params as { key: string }).key,
    ]);
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS - 240_000);
    expect(settled).toBe(true);
    await operation;
  });

  it.each([
    ["send", 45_000],
    ["send", 240_000],
    ["new", 45_000],
    ["new", 240_000],
  ] as const)(
    "%s waits through %i ms of startup and writes once",
    async (action, preparationMs) => {
      const fixture = createFixture();
      let settled = false;
      const operation =
        action === "send"
          ? fixture.commands.sendMessage("Synthetic startup request")
          : fixture.commands.handleCommand("/new");
      void operation.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(preparationMs);
      expect(settled).toBe(false);
      expect(fixture.writes).toHaveLength(0);
      fixture.ready();
      await vi.advanceTimersByTimeAsync(1_000);
      await operation;
      expect(fixture.writes).toHaveLength(1);
      expect(new Set(fixture.attempts).size).toBe(1);
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(fixture.writes).toHaveLength(1);
    },
  );

  it.each([
    ["send", "/stop"],
    ["new", "/abort"],
  ] as const)("%s is canceled by %s before startup becomes ready", async (action, stopCommand) => {
    const fixture = createFixture();
    const operation =
      action === "send"
        ? fixture.commands.sendMessage("Synthetic canceled request")
        : fixture.commands.handleCommand("/new");
    await vi.advanceTimersByTimeAsync(35_000);
    await fixture.commands.handleCommand(stopCommand);
    fixture.ready();
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    await operation;
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.state.pendingSubmit).toBeNull();
  });

  it.each(["send", "new"] as const)(
    "navigation cancels a pending %s on the old session",
    async (action) => {
      const fixture = createFixture();
      const operation =
        action === "send"
          ? fixture.commands.sendMessage("Synthetic navigation request")
          : fixture.commands.handleCommand("/new");
      await vi.advanceTimersByTimeAsync(35_000);
      await fixture.actions.setSession("agent:main:other");
      await operation;
      fixture.ready();
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.state.currentSessionKey).toBe("agent:main:other");
    },
  );
});
