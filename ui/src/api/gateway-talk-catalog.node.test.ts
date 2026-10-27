/** @vitest-environment node */
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import { startConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { GatewayRequestError } from "./gateway.ts";

let nextRequestId = 0;
const createClient = useHandshakeHarness({ randomUUID: () => `talk-request-${++nextRequestId}` });

async function connect() {
  const client = createClient({ token: "shared-auth-token" });
  const { ws, connectFrame } = await startConnect(client);
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      auth: { role: "operator", scopes: [] },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connected).toBe(true);
  return { client, ws };
}

it.each([
  { timeoutMs: undefined, expectedTimeoutMs: 10_000 },
  { timeoutMs: 30_000, expectedTimeoutMs: 10_000 },
  { timeoutMs: 1_500, expectedTimeoutMs: 1_500 },
])("bounds the first Talk catalog response wait: %j", async ({ timeoutMs, expectedTimeoutMs }) => {
  const { client, ws } = await connect();
  const settled = vi.fn();
  const result = client.request("talk.catalog", {}, { timeoutMs }).catch((error: unknown) => {
    settled();
    return error;
  });
  await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ code: "CLIENT_TIMEOUT" });
  expect(settled).toHaveBeenCalledOnce();
  expect(ws.sent).toHaveLength(2);
});

it.each(["ready", "abort", "disconnect", "stop", "timeout"] as const)(
  "bounds Talk catalog warming retries through %s",
  async (outcome) => {
    const { client, ws } = await connect();
    const abort = new AbortController();
    const params = { sessionKey: "agent:main:voice", model: "synthetic-voice" };
    const result = client.request("talk.catalog", params, { signal: abort.signal }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const first = JSON.parse(ws.sent.at(-1)!) as { id: string };
    ws.emitMessage({
      type: "res",
      id: first.id,
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Talk catalog is warming",
        retryable: true,
        retryAfterMs: 250,
        details: { reason: "talk-catalog-warming" },
      },
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(ws.sent).toHaveLength(2);
    if (outcome === "abort" || outcome === "disconnect" || outcome === "stop") {
      if (outcome === "abort") {
        abort.abort();
      } else if (outcome === "disconnect") {
        ws.emitClose(1006, "connection lost");
      } else {
        client.stop();
      }
      expect(await result).toEqual({ error: expect.any(Error) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ws.sent).toHaveLength(2);
      return;
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.sent).toHaveLength(3);
    const retry = JSON.parse(ws.sent.at(-1)!) as { id: string };
    expect(retry).toMatchObject({ method: "talk.catalog", params });
    expect(retry.id).not.toBe(first.id);
    if (outcome === "ready") {
      ws.emitMessage({ type: "res", id: retry.id, ok: true, payload: { providers: [] } });
      expect(await result).toEqual({ value: { providers: [] } });
    } else {
      await vi.advanceTimersByTimeAsync(9_750);
      expect(await result).toEqual({
        error: expect.objectContaining({ code: "CLIENT_TIMEOUT" }),
      });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sent.filter((raw) => JSON.parse(raw).method !== "health")).toHaveLength(3);
  },
);

it.each([
  { method: "config.get", reason: "talk-catalog-warming", retryable: true },
  { method: "talk.catalog", reason: "provider-unavailable", retryable: true },
  { method: "talk.catalog", reason: "talk-catalog-warming", retryable: false },
])("does not retry unrelated catalog errors: %j", async ({ method, reason, retryable }) => {
  const { client, ws } = await connect();
  const result = client.request(method).catch((error: unknown) => error);
  const frame = JSON.parse(ws.sent.at(-1)!) as { id: string };
  ws.emitMessage({
    type: "res",
    id: frame.id,
    ok: false,
    error: { code: "UNAVAILABLE", message: "unavailable", retryable, details: { reason } },
  });
  expect(await result).toBeInstanceOf(GatewayRequestError);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(ws.sent).toHaveLength(2);
});
