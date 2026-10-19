// @vitest-environment node
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { readCurrentStoredChatHistory } from "./chat-outbox-receipts.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

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

async function startPreparingSend(
  message = "Wait for this agent",
  testOptions: { holdResponse?: boolean } = {},
) {
  vi.useFakeTimers();
  let ready = false;
  const attempts: string[] = [];
  const writes: RequestFrame[] = [];
  const issued = Promise.withResolvers<void>();
  const pending = new GatewayPendingRequests({ createRequestId: () => "startup", nowMs: Date.now });
  onTestFinished(() => pending.flush(new Error("test request owner disposed")));
  const wire = {
    send(raw: string) {
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
    },
  };
  const client = createTestGatewayClient((method, params, options) =>
    method === "chat.send"
      ? pending.request(wire, method, params, options)
      : Promise.resolve({ messages: [], status: "aborted" }),
  );
  const host = makeChatHost({
    client,
    connected: true,
    sessionKey: "agent:main:startup",
    chatMessage: message,
    chatError: null,
  });
  const sending = handleSendChat(host);
  await issued.promise;
  return { host, pending, attempts, writes, sending, ready: () => (ready = true) };
}

it.each([45_000, 240_000])("delivers one UI send after %i ms of startup", async (delay) => {
  const fixture = await startPreparingSend();
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

it("Stop during startup retires the UI send before readiness", async () => {
  const fixture = await startPreparingSend();
  await vi.advanceTimersByTimeAsync(45_000);
  await handleAbortChat(fixture.host, { scope: "session" });
  await fixture.sending;
  fixture.ready();
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  expect(fixture.pending.hasPending).toBe(false);
  expect(fixture.writes).toHaveLength(0);
});

it.each([
  ["steer", 45_000],
  ["steer", 240_000],
  ["redirect", 45_000],
  ["redirect", 240_000],
] as const)("delivers one /%s send after %i ms of startup", async (command, delay) => {
  const fixture = await startPreparingSend(`/${command} Wait for this agent`);
  await vi.advanceTimersByTimeAsync(delay);
  expect(fixture.pending.hasPending).toBe(true);
  fixture.ready();
  await vi.advanceTimersByTimeAsync(1_000);
  await fixture.sending;
  expect(fixture.writes).toHaveLength(1);
  expect(new Set(fixture.attempts).size).toBe(1);
});

it.each(["steer", "redirect"] as const)("Stop retires a startup /%s send", async (command) => {
  const fixture = await startPreparingSend(`/${command} Wait for this agent`);
  await vi.advanceTimersByTimeAsync(45_000);
  await handleAbortChat(fixture.host, { scope: "session" });
  await fixture.sending;
  fixture.ready();
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
  expect(fixture.pending.hasPending).toBe(false);
  expect(fixture.writes).toHaveLength(0);
});

it.each([
  ["send", false],
  ["steer", false],
  ["redirect", false],
  ["send", true],
  ["steer", true],
  ["redirect", true],
] as const)(
  "retains a dispatched %s result after Stop (selection changed=%s)",
  async (kind, selectionChanged) => {
    const message = kind === "send" ? "Keep this submission" : `/${kind} Keep this submission`;
    const fixture = await startPreparingSend(message, { holdResponse: true });
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

    expect(fixture.host.chatError).toBeNull();
    expect(fixture.host.chatMessage).toBe(selectionChanged ? "A newer draft" : "");
    expect(fixture.host.sessionKey).toBe(selectedSessionKey);
    if (selectionChanged) {
      expect(fixture.host.chatMessages).toBe(selectedMessages);
    }
    expect(fixture.host.chatQueue).toEqual([]);
    expect(fixture.host.chatRunId).toBeNull();
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.pending.hasPending).toBe(false);
  },
);
