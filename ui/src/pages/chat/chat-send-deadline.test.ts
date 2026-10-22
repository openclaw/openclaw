// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { readCurrentStoredChatHistory } from "./chat-outbox-receipts.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

useChatSendBrowserFixture();

afterEach(() => vi.useRealTimers());
function requestFixture(id: string, startup = false) {
  vi.useFakeTimers();
  const issued = Promise.withResolvers<void>();
  const wire = { send: vi.fn<(raw: string) => void>(() => issued.resolve()) };
  const pending = new GatewayPendingRequests({ createRequestId: () => id, nowMs: Date.now });
  onTestFinished(() => pending.flush(new Error("test request owner disposed")));
  const client = createTestGatewayClient((method, params, options) =>
    !startup || method === "chat.send"
      ? pending.request(wire, method, params, options)
      : Promise.resolve({ messages: [], status: "aborted" }),
  );
  return { pending, wire, issued, host: makeChatHost({ client }) };
}

it.each(["send", "send-consumed", "receipt"] as const)(
  "bounds %s without a client deadline",
  async (kind) => {
    const { pending, wire, issued, host } = requestFixture("deadline");
    host.chatMessage = "submission";
    const retry = vi.fn();
    const item = { id: "queued", sendRunId: "original-run", text: "submission", createdAt: 1 };
    const operation =
      kind !== "receipt"
        ? handleSendChat(host)
        : readCurrentStoredChatHistory(
            host,
            { sessionKey: host.sessionKey, queue: [item] },
            item,
            host.client!,
            host.connectionEpoch,
            retry,
          );
    const deadline = kind === "receipt" ? 30_000 : GATEWAY_STARTUP_ADMISSION_WAIT_MS;
    await issued.promise;
    expect(wire.send).toHaveBeenCalledOnce();
    expect(pending.hasUnboundedPending).toBe(false);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(pending.hasPending).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    if (kind === "send-consumed") {
      const runId = host.chatQueue[0]!.sendRunId!;
      applyChatPendingInputs(host, undefined, {
        receipts: [{ runId, state: "consumed", consumedByEventId: "canonical-user" }],
      });
      expect(host.chatQueue).toEqual([]);
      host.chatMessage = "A newer draft";
    }
    await vi.advanceTimersByTimeAsync(1);
    if (kind !== "receipt") {
      await operation;
      if (kind === "send-consumed") {
        expect(host.chatQueue).toEqual([]);
        expect(host.chatMessage).toBe("A newer draft");
      } else {
        expect(host.chatQueue[0]).toMatchObject({ sendState: "unconfirmed", sendAttempts: 1 });
      }
      expect(host.chatError).toBeNull();
      host.connected = false;
      await vi.advanceTimersByTimeAsync(500);
    } else {
      expect(await operation).toBe("blocked");
      expect(retry).toHaveBeenCalledExactlyOnceWith(500);
    }
    expect(pending.hasPending).toBe(false);
    expect(wire.send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retains audio until its connection acknowledges", async () => {
  const { pending, wire, host } = requestFixture("audio-ack");
  const send = requestChatSend(host, {
    message: "caption",
    runId: "audio-run",
    attachments: [{ id: "voice", mimeType: "audio/wav", dataUrl: "data:audio/wav;base64,YQ==" }],
  });
  const settled = vi.fn();
  void send.then(settled, settled);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).not.toHaveBeenCalled();
  expect(pending.hasUnboundedPending).toBe(true);
  const frame: unknown = JSON.parse(wire.send.mock.calls[0]![0]);
  const id = asOptionalRecord(frame)?.id;
  if (typeof id !== "string") {
    throw new Error("Expected an issued chat.send request id");
  }
  const ack = { runId: "audio-run", status: "started" };
  pending.handleResponse({ type: "res", id, ok: true, payload: { ...ack } });
  expect(await send).toMatchObject(ack);
  expect(pending.hasPending).toBe(false);
  expect(wire.send).toHaveBeenCalledOnce();
});

async function startPreparingSend(
  message = "Wait for this agent",
  testOptions: { holdResponse?: boolean } = {},
) {
  const { pending, wire, issued, host } = requestFixture("startup", true);
  host.sessionKey = "agent:main:startup";
  host.chatError = null;
  let ready = false;
  const attempts: string[] = [];
  const writes: RequestFrame[] = [];
  wire.send.mockImplementation((raw) => {
    const request = JSON.parse(raw) as RequestFrame;
    attempts.push(raw);
    if (ready) {
      writes.push(request);
      if (testOptions.holdResponse) {
        return;
      }
    }
    pending.handleResponse({
      type: "res",
      id: request.id,
      ok: ready,
      ...(ready
        ? { payload: { status: "ok", runId: "started" } }
        : {
            error: {
              code: "UNAVAILABLE",
              message: "Agent is preparing",
              retryable: true,
              retryAfterMs: 1_000,
              details: { reason: "startup-sidecars", method: request.method },
            },
          }),
    });
    issued.resolve();
  });
  host.chatMessage = message;
  const sending = handleSendChat(host);
  await issued.promise;
  return { host, pending, attempts, writes, sending, ready: () => (ready = true) };
}

describe.each(["send", "steer", "redirect"] as const)("%s startup", (command) => {
  const message = (text: string) => (command === "send" ? text : `/${command} ${text}`);
  it.each([45_000, 240_000])("delivers once after %i ms", async (delay) => {
    const fixture = await startPreparingSend(message("Wait for this agent"));
    await vi.advanceTimersByTimeAsync(delay);
    expect(fixture.pending.hasPending).toBe(true);
    expect(fixture.writes).toHaveLength(0);
    fixture.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.sending;
    expect(fixture.writes).toHaveLength(1);
    expect(new Set(fixture.attempts).size).toBe(1);
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(fixture.writes).toHaveLength(1);
  });

  it("Stop retires a pending send", async () => {
    const fixture = await startPreparingSend(message("Wait for this agent"));
    await vi.advanceTimersByTimeAsync(45_000);
    await handleAbortChat(fixture.host, { scope: "session" });
    await fixture.sending;
    fixture.ready();
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(fixture.pending.hasPending).toBe(false);
    expect(fixture.writes).toHaveLength(0);
  });

  it.each([false, true])("retains ACKs after Stop (navigated: %s)", async (selectionChanged) => {
    const fixture = await startPreparingSend(message("Keep this submission"), {
      holdResponse: true,
    });
    fixture.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.writes).toHaveLength(1);
    const request = fixture.writes[0]!;

    await handleAbortChat(fixture.host, { scope: "session" });
    if (selectionChanged) {
      fixture.host.sessionKey = "agent:main:newer";
      fixture.host.chatMessage = "A newer draft";
    }
    const selectedSessionKey = fixture.host.sessionKey;
    const selectedMessages = fixture.host.chatMessages;
    fixture.pending.handleResponse({
      type: "res",
      id: request.id,
      ok: true,
      payload: {
        status: selectionChanged ? "started" : "ok",
        runId: "accepted-after-stop",
        messageSeq: 1,
      },
    });
    await fixture.sending;

    expect(fixture.host).toMatchObject({
      chatError: null,
      chatMessage: selectionChanged ? "A newer draft" : "",
      sessionKey: selectedSessionKey,
      chatQueue: [],
      chatRunId: null,
    });
    if (selectionChanged) {
      expect(fixture.host.chatMessages).toBe(selectedMessages);
    }
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.pending.hasPending).toBe(false);
  });
});
