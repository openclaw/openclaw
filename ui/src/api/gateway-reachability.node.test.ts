/** @vitest-environment node */
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useSocketHarness } from "./gateway-handshake.test-support.ts";
import { getLatestWebSocket, wsInstances } from "./gateway-socket.test-support.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const createClient = useSocketHarness();
const fetchProbe = vi.fn<() => Promise<Response>>();
const onClose = vi.fn();

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  fetchProbe.mockReset();
  onClose.mockReset();
  vi.stubGlobal("fetch", fetchProbe);
});

function connect(url = gatewayUrl) {
  const client = createClient({ url, onClose });
  client.start();
  return { client, socket: getLatestWebSocket() };
}

it.each([
  { name: "live Gateway", body: { ok: true, status: "live" }, status: 200, busy: true },
  { name: "unavailable HTTP server", body: { ok: false }, status: 503, busy: false },
  { name: "unrelated HTTP server", body: { ok: true }, status: 200, busy: false },
  { name: "offline Gateway", body: null, status: 0, busy: false },
])("classifies a failed upgrade against a $name", async ({ body, status, busy }) => {
  fetchProbe.mockImplementation(() =>
    status
      ? Promise.resolve(Response.json(body, { status }))
      : Promise.reject(new TypeError("offline")),
  );
  const { socket } = connect();
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
  const { socket } = connect(kind === "cross-origin" ? "wss://gateway.example" : gatewayUrl);
  if (kind === "opened") {
    socket.emitOpen();
  }
  socket.emitClose(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchProbe).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onClose.mock.calls[0]?.[0].busy).toBeUndefined();
});

it.each(["stop", "retry"])("discards a late liveness response after %s", async (action) => {
  const pending = createDeferred<Response>();
  fetchProbe.mockReturnValue(pending.promise);
  const { client, socket } = connect();
  socket.emitClose(1006);
  if (action === "stop") {
    client.stop();
  } else {
    await vi.advanceTimersByTimeAsync(800);
  }
  pending.resolve(Response.json({ ok: true, status: "live" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(onClose).not.toHaveBeenCalled();
});

it("reports an opening timeout before retrying even when the HTTP probe cannot finish", async () => {
  const pending = createDeferred<Response>();
  fetchProbe.mockReturnValue(pending.promise);
  const { socket } = connect();

  await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  expect(socket.lastClose).not.toBeNull();
  socket.emitClose(1006);
  await vi.advanceTimersByTimeAsync(0);

  expect(onClose).toHaveBeenCalledExactlyOnceWith({
    code: 1006,
    reason: "gateway websocket opening timed out after 30000ms",
    error: undefined,
    willRetry: true,
  });
  expect(fetchProbe).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(800);
  expect(wsInstances).toHaveLength(2);
  expect(onClose).toHaveBeenCalledOnce();
});
