// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { chatHistoryRequests, getChatHistoryLoadState } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { readQueuedMessageById, removeQueuedMessage } from "./chat-queue.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { startupAdmissionResponse } from "./chat-startup-response.test-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

useChatSendBrowserFixture();

afterEach(() => vi.useRealTimers());

function createHeldHistory() {
  return {
    response: Promise.withResolvers<{ messages: never[]; status: "aborted" }>(),
    issued: Promise.withResolvers<void>(),
    storage: sessionStorage,
    sendRunIds: [] as unknown[],
    signal: undefined as AbortSignal | undefined,
    requests: 0,
  };
}

function requestFixture(
  id: string,
  startup = false,
  history?: ReturnType<typeof createHeldHistory>,
) {
  vi.useFakeTimers();
  const issued = Promise.withResolvers<void>();
  const wire = { send: vi.fn<(raw: string) => void>(() => issued.resolve()) };
  const pending = new GatewayPendingRequests({ createRequestId: () => id, nowMs: Date.now });
  onTestFinished(() => pending.flush(new Error("test request owner disposed")));
  const client = createTestGatewayClient((method, params, options) => {
    if (history && method === "chat.send") {
      history.sendRunIds.push(asOptionalRecord(params)?.idempotencyKey);
    }
    if (history && method === "chat.history" && history.requests++ === 0) {
      history.signal = options?.signal;
      history.issued.resolve();
      return history.response.promise;
    }
    return !startup || method === "chat.send"
      ? pending.request(wire, method, params, options)
      : Promise.resolve({ messages: [], status: "aborted" });
  });
  const host = makeChatHost({ client, currentSessionId: "deadline-session" });
  // A visible pane retains its outbox owner throughout delivery and discard.
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(() => {
    // A retired fixture must not drain the next test's outbox through its old client.
    host.connected = false;
    unsubscribe();
  });
  return { pending, wire, issued, host };
}

it.each(["send", "send-consumed"] as const)("bounds %s without a client deadline", async (kind) => {
  const { pending, wire, issued, host } = requestFixture("deadline");
  host.chatMessage = "submission";
  const operation = handleSendChat(host);
  await issued.promise;
  expect(wire.send).toHaveBeenCalledOnce();
  expect(pending.hasUnboundedPending).toBe(false);
  await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS - 1);
  expect(pending.hasPending).toBe(true);
  if (kind === "send-consumed") {
    const runId = host.chatQueue[0]!.sendRunId!;
    applyChatPendingInputs(host, undefined, {
      receipts: [{ runId, state: "consumed", consumedByEventId: "canonical-user" }],
    });
    expect(host.chatQueue).toEqual([]);
    host.chatMessage = "A newer draft";
  }
  await vi.advanceTimersByTimeAsync(1);
  await operation;
  if (kind === "send-consumed") {
    expect(host.chatQueue).toEqual([]);
    expect(host.chatMessage).toBe("A newer draft");
  } else {
    expect(host.chatQueue[0]).toMatchObject({ sendState: "waiting-reconnect", sendAttempts: 1 });
  }
  expect(host.chatError).toBeNull();
  host.connected = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(pending.hasPending).toBe(false);
  expect(wire.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

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
  testOptions: { holdResponse?: boolean; history?: ReturnType<typeof createHeldHistory> } = {},
) {
  const { pending, wire, issued, host } = requestFixture("startup", true, testOptions.history);
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
    pending.handleResponse(startupAdmissionResponse(request, ready));
    issued.resolve();
  });
  host.chatMessage = message;
  const sending = handleSendChat(host);
  await issued.promise;
  return { host, pending, attempts, writes, sending, ready: () => (ready = true) };
}

it.each(["ready", "discard"])(
  "retains refused sends past the request deadline: %s",
  async (ending) => {
    const fixture = await startPreparingSend("Keep waiting for this agent");
    const original = JSON.parse(fixture.attempts[0]!) as RequestFrame;
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    await fixture.sending;
    expect(fixture.host.chatQueue[0]).toMatchObject({ sendState: "waiting-reconnect" });
    expect(fixture.host.chatError).toBeNull();
    expect(fixture.writes).toHaveLength(0);
    if (ending === "discard") {
      expect(
        removeQueuedMessage(fixture.host, fixture.host.chatQueue[0]!.id, { discard: true }),
      ).toBe("removed");
    }
    fixture.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => expect(fixture.writes).toHaveLength(ending === "ready" ? 1 : 0));
    if (ending === "ready") {
      expect(fixture.writes[0]?.params).toEqual(original.params);
    }
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(fixture.writes).toHaveLength(ending === "ready" ? 1 : 0);
    expect(fixture.pending.hasPending).toBe(false);
  },
);

describe.each(["send", "steer", "redirect"] as const)("%s startup", (command) => {
  const message = (text: string) => (command === "send" ? text : `/${command} ${text}`);
  it("delivers once after four minutes of startup", async () => {
    const fixture = await startPreparingSend(message("Wait for this agent"));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fixture.pending.hasPending).toBe(true);
    expect(fixture.writes).toHaveLength(0);
    fixture.ready();
    await vi.advanceTimersByTimeAsync(8_000);
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

describe("held history fixture lifetime", () => {
  let history: ReturnType<typeof createHeldHistory> | undefined;
  let retained:
    | {
        host: ReturnType<typeof makeChatHost>;
        client: ReturnType<typeof makeChatHost>["client"];
        connectionEpoch: number;
        load: Promise<unknown>;
        signal: AbortSignal | undefined;
      }
    | undefined;

  afterAll(async () => {
    // Also release the synthetic transport if either regression assertion fails.
    history?.response.resolve({ messages: [], status: "aborted" });
    await retained?.load;
    await vi.dynamicImportSettled();
  });

  it("holds ready history through fixture retirement", async () => {
    history = createHeldHistory();
    const fixture = await startPreparingSend("Ready history owner", { history });
    fixture.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.sending;
    await history.issued.promise;
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.pending.hasPending).toBe(false);
    expect(fixture.host.chatQueue).toEqual([]);
    const load = getChatHistoryLoadState(fixture.host);
    expect(load.phase).toBe("in-flight");
    if (load.phase !== "in-flight") {
      throw new Error("Expected the ready fixture's history read to remain in flight");
    }
    retained = {
      host: fixture.host,
      client: fixture.host.client,
      connectionEpoch: fixture.host.connectionEpoch,
      load: load.promise,
      signal: chatHistoryRequests(fixture.host).historyRead?.signal,
    };
    expect(retained.signal?.aborted).toBe(false);
    expect(history.signal?.aborted).toBe(false);
    // Return before the history deadline; real fixture cleanup owns retirement.
  });

  it("rejects retired history work against the next fixture queue", async () => {
    const fixture = await startPreparingSend("Next fixture owns this row");
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    await fixture.sending;
    if (!history || !retained) {
      throw new Error("Expected the preceding fixture's held history");
    }
    const queued = fixture.host.chatQueue[0]!;
    const before = {
      visible: structuredClone(fixture.host.chatQueue),
      canonical: structuredClone(readQueuedMessageById(fixture.host, queued.id)),
    };
    const beforeMs = Date.now();
    const oldSends = [...history.sendRunIds];
    expect(history.storage).not.toBe(sessionStorage);
    expect(history.requests).toBe(1);
    expect(queued).toMatchObject({ sendState: "waiting-reconnect", sendAttempts: 1 });
    expect(fixture.pending.hasPending).toBe(false);
    expect(retained.host.connected).toBe(false);
    expect(retained.host.connectionEpoch).toBeGreaterThan(retained.connectionEpoch);
    expect(retained.host.client).toBe(retained.client);
    expect(retained.signal?.aborted).toBe(true);
    expect(history.signal?.aborted).toBe(true);
    // Only release the old response; never flush or advance the new retry owner.
    history.response.resolve({ messages: [], status: "aborted" });
    await retained.load;
    await vi.dynamicImportSettled();
    expect(Date.now()).toBe(beforeMs);
    expect(history.sendRunIds).toEqual(oldSends);
    expect(history.sendRunIds).not.toContain(queued.sendRunId);
    expect({
      visible: structuredClone(fixture.host.chatQueue),
      canonical: structuredClone(readQueuedMessageById(fixture.host, queued.id)),
    }).toEqual(before);
    expect(fixture.writes).toHaveLength(0);
    expect(removeQueuedMessage(fixture.host, queued.id, { discard: true })).toBe("removed");
  });
});
