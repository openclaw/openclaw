// @vitest-environment node
import { randomUUID } from "node:crypto";
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "../../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatAttachmentBlob, getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { UNCONFIRMED_CHAT_SEND_ERROR } from "./chat-send-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
beforeEach(() => {
  useNodeFakeTimers();
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  stubWindowGlobals(storage);
  vi.stubGlobal("WebSocket", MockWebSocket);
  // Exercise the real browser protocol without unrelated device-signing setup.
  vi.stubGlobal("crypto", { randomUUID });
  wsInstances.length = 0;
  onTestFinished(() => {
    vi.useRealTimers();
  });
});

type RequestFrame = { id: string; method: string; params: Record<string, unknown> };
function requests(ws: MockWebSocket, method: string): RequestFrame[] {
  return ws.sent
    .map((frame) => JSON.parse(frame) as RequestFrame)
    .filter((frame) => frame.method === method);
}
async function connect(client: GatewayBrowserClient, recoveryScope = "account-a") {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "ack-deadline-challenge", ts: Date.now() },
  });
  await vi.advanceTimersByTimeAsync(0);
  const frame = requests(ws, "connect")[0]!;
  expect(frame).toBeDefined();
  ws.emitMessage({
    type: "res",
    id: frame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.admin"], recoveryScope },
      policy: { tickIntervalMs: 1_000 },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connected).toBe(true);
  return ws;
}
async function heartbeatUntilDeadline(ws: MockWebSocket) {
  for (let seq = 1; seq < 30; seq += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    for (const socket of wsInstances) {
      socket.emitMessage({ type: "event", event: "tick", seq, payload: {} });
    }
  }
  await vi.advanceTimersByTimeAsync(999);
  expect(ws.lastClose).toBeNull();
}

async function startApproval() {
  const attachment = createStagedAttachment("approval-ack-document");
  const bytes = getChatAttachmentBlob(attachment);
  const message = "/approve approval-123 allow-once";
  const host = makeChatHost({
    chatMessage: message,
    chatAttachments: [attachment],
    chatRunId: "active-run",
    chatStream: "Waiting for approval",
  });
  const client = new GatewayBrowserClient({
    url: "ws://127.0.0.1:18789",
    onHello: (hello) => {
      host.hello = hello;
    },
  });
  host.client = client;
  onTestFinished(() => client.stop());
  const ws = await connect(client);
  const observed = vi.spyOn(client, "request");
  const settled = vi.fn();
  const sending = handleSendChat(host).then(settled);
  await vi.advanceTimersByTimeAsync(0);
  const send = requests(ws, "chat.send")[0]!;
  expect(send.params).toMatchObject({ message, sessionKey: host.sessionKey });
  expect(host.chatMessage).toBe("");
  expect(host.chatSubmitGuards?.size).toBe(1);
  return { host, client, ws, observed, settled, sending, send, attachment, bytes, message };
}

it("settles a detached approval at its ACK deadline despite healthy ticks, without replay", async () => {
  const { host, client, ws, observed, settled, sending, send, attachment, bytes, message } =
    await startApproval();
  await heartbeatUntilDeadline(ws);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ws.lastClose).toBeNull();
  expect(client.connected).toBe(true);
  expect(settled).toHaveBeenCalledOnce();
  await sending;
  const result = observed.mock.results[0]!;
  if (result.type !== "return") {
    throw new Error("chat.send did not return its protocol promise");
  }
  await expect(result.value).rejects.toBeInstanceOf(GatewayProtocolRequestTimeoutError);
  await expect(result.value).rejects.toMatchObject({
    requestSent: true,
    timeoutMs: 30_000,
    method: "chat.send",
  });
  expect(host.chatSubmitGuards?.size).toBe(0);
  expect(host.chatRunId).toBe("active-run");
  expect(host.chatStream).toBe("Waiting for approval");
  expect(host.chatError).toBe(UNCONFIRMED_CHAT_SEND_ERROR);
  expect(host.chatMessage).toBe(message);
  expect(host.chatAttachments).toMatchObject([{ id: attachment.id }]);
  expect(getChatAttachmentBlob(host.chatAttachments[0]!)).toBe(bytes);
  expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(
    "data:application/pdf;base64,JVBERi0xLjQK",
  );
  expect(host.chatQueue).toEqual([]);
  ws.emitMessage({
    type: "res",
    id: send.id,
    ok: true,
    payload: { status: "started", runId: "late-command" },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(host.chatMessage).toBe(message);
  expect(host.chatError).toBe(UNCONFIRMED_CHAT_SEND_ERROR);
  expect(host.chatRunId).toBe("active-run");
  client.stop();
  await connect(client);
  await resumeStoredChatOutboxes(host);
  expect(wsInstances.flatMap((socket) => requests(socket, "chat.send"))).toHaveLength(1);
  expect(host.chatMessage).toBe(message);
  expect(host.chatRunId).toBe("active-run");
});

it.each(["newer input", "navigation", "account"] as const)(
  "fences an expired approval and late ACK after %s",
  async (change) => {
    const { host, ws, settled, sending, send, attachment, bytes, message } = await startApproval();
    const originalSessionKey = host.sessionKey;
    const newerAttachment = createStagedAttachment("newer-approval-document");
    const newerBytes = getChatAttachmentBlob(newerAttachment);
    host.chatMessage = "Keep my newer input";
    host.chatAttachments = [newerAttachment];
    host.chatError = "Current context notice";
    if (change === "navigation") {
      host.sessionKey = "agent:main:other";
    } else if (change === "account") {
      const replacement = new GatewayBrowserClient({
        url: "ws://127.0.0.1:18789",
        onHello: (hello) => {
          host.hello = hello;
        },
      });
      host.client = replacement;
      host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
      onTestFinished(() => replacement.stop());
      await connect(replacement, "account-b");
    }
    await heartbeatUntilDeadline(ws);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    await sending;
    expect(host.chatSubmitGuards?.size).toBe(0);
    expect(host.chatMessage).toBe("Keep my newer input");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(getChatAttachmentBlob(newerAttachment)).toBe(newerBytes);
    expect(host.chatError).toBe(
      change === "newer input" ? UNCONFIRMED_CHAT_SEND_ERROR : "Current context notice",
    );
    expect(host.chatRunId).toBe("active-run");
    if (change === "navigation") {
      const saved = Object.values(host.chatComposerFallbackByScope);
      expect(saved).toEqual([
        expect.objectContaining({
          message,
          attachments: [expect.objectContaining({ id: attachment.id })],
        }),
      ]);
      expect(getChatAttachmentBlob(saved[0]!.attachments[0]!)).toBe(bytes);
      expect(Object.keys(host.chatComposerFallbackByScope)[0]).toContain(originalSessionKey);
    } else {
      expect(host.chatComposerFallbackByScope).toEqual({});
    }
    const fallback = structuredClone(host.chatComposerFallbackByScope);
    ws.emitMessage({
      type: "res",
      id: send.id,
      ok: true,
      payload: { status: "started", runId: "late-command" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await resumeStoredChatOutboxes(host);
    expect(host.chatMessage).toBe("Keep my newer input");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(host.chatComposerFallbackByScope).toEqual(fallback);
    expect(host.chatRunId).toBe("active-run");
    expect(wsInstances.flatMap((socket) => requests(socket, "chat.send"))).toHaveLength(1);
  },
);

it.each(["success", "terminal error", "known rejection"] as const)(
  "preserves detached approval %s settlement before the ACK deadline",
  async (outcome) => {
    const { host, ws, settled, sending, send, attachment, message } = await startApproval();
    ws.emitMessage(
      outcome === "known rejection"
        ? {
            type: "res",
            id: send.id,
            ok: false,
            error: { code: "INVALID_REQUEST", message: "Approval rejected" },
          }
        : {
            type: "res",
            id: send.id,
            ok: true,
            payload: { status: outcome === "success" ? "started" : "error", runId: "command-run" },
          },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    await sending;
    expect(host.chatSubmitGuards?.size).toBe(0);
    expect(host.chatRunId).toBe("active-run");
    if (outcome === "success") {
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual([]);
      expect(getChatAttachmentBlob(attachment)).toBeNull();
      expect(host.chatError).toBeNull();
    } else {
      expect(host.chatMessage).toBe(message);
      expect(host.chatAttachments).toMatchObject([{ id: attachment.id }]);
      expect(host.chatError).toBe(
        outcome === "known rejection"
          ? "Approval rejected"
          : "Chat failed before the run started; try again.",
      );
      expect(host.chatError).not.toBe(UNCONFIRMED_CHAT_SEND_ERROR);
    }
    const previousError = host.chatError;
    await heartbeatUntilDeadline(ws);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.chatError).toBe(previousError);
    expect(settled).toHaveBeenCalledOnce();
    expect(requests(ws, "chat.send")).toHaveLength(1);
  },
);

it("does not call a known unsent timeout unconfirmed", async () => {
  const error = new GatewayProtocolRequestTimeoutError({
    method: "chat.send",
    timeoutMs: 30_000,
    requestSent: false,
  });
  const host = makeChatHost({
    chatMessage: "/approve approval-123 allow-once",
    chatRunId: "active-run",
    requestHandlers: {
      "chat.send": () => {
        throw error;
      },
    },
  });
  await handleSendChat(host);
  expect(host.chatError).toBe(error.message);
  expect(host.chatMessage).toBe("/approve approval-123 allow-once");
  expect(host.chatSubmitGuards?.size).toBe(0);
  expect(host.chatRunId).toBe("active-run");
});
