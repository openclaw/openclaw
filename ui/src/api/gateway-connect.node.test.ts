/** @vitest-environment node */
import {
  GATEWAY_CLIENT_CAPS,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

async function startConnect(client: GatewayBrowserClient) {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "handshake-challenge", ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
    id: string;
    method: string;
    params: ConnectParams;
  };
  return { ws, connectFrame };
}

describe("GatewayBrowserClient shared-auth handshake", () => {
  let client: GatewayBrowserClient | undefined;

  beforeEach(() => {
    useNodeFakeTimers();
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    vi.stubGlobal("WebSocket", MockWebSocket);
    // Insecure browsers retain random IDs but have no device-proof crypto.
    vi.stubGlobal("crypto", { randomUUID: () => "handshake-request" });
    wsInstances.length = 0;
  });
  afterEach(() => {
    client?.stop();
    client = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests full control ui operator scopes with explicit shared auth", async () => {
    client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      clientBuildId: "build-a",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.minProtocol).toBe(MIN_CLIENT_PROTOCOL_VERSION);
    expect(connectFrame.params?.maxProtocol).toBe(PROTOCOL_VERSION);
    expect(connectFrame.params?.client.buildId).toBe("build-a");
    expect(connectFrame.params?.caps).toEqual([
      GATEWAY_CLIENT_CAPS.AGENT_KIND,
      GATEWAY_CLIENT_CAPS.APPROVALS,
      GATEWAY_CLIENT_CAPS.DEVICE_PAIRING_WAIT,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
      GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
      GATEWAY_CLIENT_CAPS.UI_COMMANDS,
      GATEWAY_CLIENT_CAPS.ULTRAFAST,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    ]);
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it.each([
    { retryAfterMs: 500, draw: 0.25, delayMs: 525 },
    { retryAfterMs: 500, draw: 0.75, delayMs: 575 },
    { retryAfterMs: 90_000, draw: 0.5, delayMs: 2_200 },
  ])("spreads bounded startup retries across tabs: %j", async ({ retryAfterMs, draw, delayMs }) => {
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const onClose = vi.fn();
    const onReconnectScheduled = vi.fn();
    client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
      onClose,
      onReconnectScheduled,
    });
    const { ws, connectFrame } = await startConnect(client);
    const error = {
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
      retryAfterMs,
    };
    ws.emitMessage({ type: "res", id: connectFrame.id, ok: false, error });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.lastClose).toEqual({ code: 4013, reason: "gateway starting" });
    ws.emitClose(4013, "gateway starting");
    expect(onClose).toHaveBeenCalledWith({
      code: 4013,
      reason: "gateway starting",
      error,
      willRetry: true,
    });
    expect(onReconnectScheduled).toHaveBeenCalledExactlyOnceWith(delayMs);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(wsInstances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsInstances).toHaveLength(2);
  });
});
