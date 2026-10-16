// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { readCurrentStoredChatHistory } from "./chat-outbox-receipts.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

afterEach(() => vi.useRealTimers());

it.each(["send", "send-consumed", "receipt"] as const)(
  "bounds the actual %s request without a client-wide deadline",
  async (kind) => {
    vi.useFakeTimers();
    const issued = Promise.withResolvers<void>();
    const wire = { send: vi.fn(() => issued.resolve()) };
    const pending = new GatewayPendingRequests({
      createRequestId: () => "deadline",
      nowMs: Date.now,
    });
    onTestFinished(() => pending.flush(new Error("test request owner disposed")));
    const client = createTestGatewayClient((method, params, options) =>
      pending.request(wire, method, params, options),
    );
    const host = makeChatHost({
      client,
      connected: true,
      sessionKey: "agent:main:deadline",
      chatMessage: "Keep this submission",
    });
    const retry = vi.fn();
    const item = {
      id: "queued",
      sendRunId: "original-run",
      text: "Keep this submission",
      createdAt: 1,
    };
    const operation =
      kind !== "receipt"
        ? handleSendChat(host)
        : readCurrentStoredChatHistory(
            host,
            { sessionKey: host.sessionKey, queue: [item] },
            item,
            client,
            host.connectionEpoch,
            retry,
          );
    await issued.promise;
    expect(wire.send).toHaveBeenCalledOnce();
    expect(pending.hasUnboundedPending).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
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

it("retains an audio send through slow transcription and settles on the captured connection", async () => {
  vi.useFakeTimers();
  const pending = new GatewayPendingRequests({
    createRequestId: () => "audio-ack",
    nowMs: Date.now,
  });
  onTestFinished(() => pending.flush(new Error("test request owner disposed")));
  const wire = { send: vi.fn<(frame: string) => void>() };
  const client = createTestGatewayClient((method, params, options) =>
    pending.request(wire, method, params, options),
  );
  const host = makeChatHost({ client, connected: true, sessionKey: "agent:main:audio-deadline" });
  const send = requestChatSend(host, {
    message: "caption",
    runId: "audio-run",
    attachments: [
      {
        id: "voice",
        mimeType: "audio/wav",
        fileName: "voice.wav",
        dataUrl: "data:audio/wav;base64,YXVkaW8=",
      },
    ],
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
  pending.handleResponse({
    type: "res",
    id,
    ok: true,
    payload: { runId: "audio-run", status: "started" },
  });
  expect(await send).toMatchObject({ runId: "audio-run", status: "started" });
  expect(pending.hasPending).toBe(false);
  expect(wire.send).toHaveBeenCalledOnce();
});
