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

function createFixture() {
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
      protocol.handleMessage(
        socket,
        1,
        JSON.stringify({
          type: "res",
          id: req.id,
          ok: !write || ready,
          ...(write && !ready
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
    },
  };
  Object.assign(protocol, { socket, stopped: false, generation: 1 });
  const state = createBaseState({ historyLoaded: true });
  const chatLog = makeChatLog();
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

  it.each(["send", "new"] as const)(
    "Stop cancels a pending %s before startup becomes ready",
    async (action) => {
      const fixture = createFixture();
      const operation =
        action === "send"
          ? fixture.commands.sendMessage("Synthetic canceled request")
          : fixture.commands.handleCommand("/new");
      await vi.advanceTimersByTimeAsync(35_000);
      await fixture.actions.abortActive();
      await operation;
      fixture.ready();
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.state.pendingSubmit).toBeNull();
    },
  );

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
