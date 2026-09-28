/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const clients: GatewayBrowserClient[] = [];

beforeEach(() => {
  useNodeFakeTimers();
  stubWindowGlobals();
  wsInstances.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function connect(url = gatewayUrl) {
  const onClose = vi.fn();
  const client = new GatewayBrowserClient({ url, onClose });
  clients.push(client);
  client.start();
  return { client, onClose, socket: getLatestWebSocket() };
}

it.each([
  { name: "live Gateway", body: { ok: true, status: "live" }, status: 200, busy: true },
  { name: "unavailable HTTP server", body: { ok: false }, status: 503, busy: false },
  { name: "unrelated HTTP server", body: { ok: true }, status: 200, busy: false },
  { name: "offline Gateway", body: null, status: 0, busy: false },
])("classifies a failed upgrade against a $name", async ({ body, status, busy }) => {
  const fetchProbe = vi.fn(() =>
    status
      ? Promise.resolve(Response.json(body, { status }))
      : Promise.reject(new TypeError("offline")),
  );
  vi.stubGlobal("fetch", fetchProbe);
  const { onClose, socket } = connect();
  socket.emitClose(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchProbe).toHaveBeenCalledExactlyOnceWith(
    new URL("http://127.0.0.1:18789/healthz"),
    expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }),
  );
  expect(onClose).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: 1006, willRetry: true, ...(busy ? { busy: true } : {}) }),
  );
  expect(onClose.mock.calls[0]?.[0].busy === true).toBe(busy);
});

it.each(["cross-origin", "opened"])("does not probe a %s transport", async (kind) => {
  const fetchProbe = vi.fn();
  vi.stubGlobal("fetch", fetchProbe);
  const { socket, onClose } = connect(
    kind === "cross-origin" ? "wss://gateway.example" : gatewayUrl,
  );
  if (kind === "opened") socket.emitOpen();
  socket.emitClose(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchProbe).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onClose.mock.calls[0]?.[0].busy).toBeUndefined();
});

it.each(["stop", "retry"])("discards a late liveness response after %s", async (action) => {
  const pending = createDeferred<Response>();
  const fetchProbe = vi.fn(() => pending.promise);
  vi.stubGlobal("fetch", fetchProbe);
  const { client, socket, onClose } = connect();
  socket.emitClose(1006);
  if (action === "stop") client.stop();
  else await vi.advanceTimersByTimeAsync(800);
  pending.resolve(Response.json({ ok: true, status: "live" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(onClose).not.toHaveBeenCalled();
});
