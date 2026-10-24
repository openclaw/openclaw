// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "../../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createGatewayHarness } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createResolvedModelPatch,
  createSessionsListResult,
} from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { switchChatModel } from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

useChatSendBrowserFixture();
beforeEach(() => {
  useNodeFakeTimers();
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  stubWindowGlobals(storage);
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("crypto", { randomUUID });
  wsInstances.length = 0;
  onTestFinished(() => {
    vi.useRealTimers();
  });
});

type Frame = { id: string; method: string; params: Record<string, unknown> };
function requests(ws: MockWebSocket, method: string): Frame[] {
  return ws.sent
    .map((text) => JSON.parse(text) as Frame)
    .filter((frame) => frame.method === method);
}
function respond(ws: MockWebSocket, frame: Frame, payload: unknown) {
  ws.emitMessage({ type: "res", id: frame.id, ok: true, payload });
}
const message = "Synthetic settings interruption diagnostic";
const nextModel = "gpt-5-mini";
const roster = createSessionsListResult({ model: nextModel, modelOverrideSource: "user" });
roster.sessions[0]!.sessionId = "main";

async function fixture({ activeRun = false } = {}) {
  const bootstrap = createConnectionBootstrapCoordinator();
  const client = new GatewayBrowserClient({
    url: "ws://127.0.0.1:18789",
    onHello(hello) {
      host.connected = true;
      host.hello = hello;
      bootstrap.synchronize({ client, connected: true });
      gateway.update({ phase: "connected", hello });
    },
    onClose() {
      host.connected = false;
      host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
      markQueuedChatSendsWaitingForReconnect(host);
      bootstrap.synchronize({ client, connected: false });
      gateway.publish(false);
    },
  });
  const gateway = createGatewayHarness(client, undefined, {
    initial: { phase: "reconnecting", sessionKey: "main" },
  });
  const sessions = createSessionCapability(
    gateway.gateway,
    { state: { selectedId: "main" }, subscribe: () => () => undefined },
    { connectionBootstrap: bootstrap },
  );
  const host = makeChatHost({
    client,
    sessions,
    connected: false,
    sessionKey: "main",
    chatMessage: message,
  });
  onTestFinished(() => {
    sessions.dispose();
    client.stop();
    bootstrap.reset();
  });
  async function connect() {
    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();
    ws.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "settings-diagnostic", ts: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(0);
    respond(ws, requests(ws, "connect")[0]!, {
      ...sessionMutationGatewayHello(),
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "agent:main:main",
        },
      },
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        recoveryScope: "settings-diagnostic-account",
      },
      policy: { tickIntervalMs: 30_000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connected).toBe(true);
    for (const frame of requests(ws, "sessions.list")) {
      const result = createSessionsListResult({ model: "gpt-5", modelOverrideSource: "user" });
      if (activeRun) {
        Object.assign(result.sessions[0]!, {
          sessionId: "main",
          hasActiveRun: true,
          status: "running",
        });
      }
      respond(ws, frame, result);
    }
    await vi.advanceTimersByTimeAsync(0);
    return ws;
  }
  const ws = await connect();
  return { host, sessions, bootstrap, client, ws, connect };
}

it.each(["patch", "queued reconciliation", "in-flight reconciliation"] as const)(
  "settles a real settings barrier when the socket closes during %s",
  async (point) => {
    const { host, sessions, bootstrap, client, ws, connect } = await fixture();
    const selection = switchChatModel(host, `openai/${nextModel}`);
    const sending = handleSendChat(host);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.chatQueue[0]).toMatchObject({
      text: message,
      sendState: "waiting-model",
      sendAttempts: 0,
    });
    expect(requests(ws, "chat.send")).toHaveLength(0);
    const patch = requests(ws, "sessions.patch")[0]!;
    expect(patch).toBeDefined();
    const listsBefore = requests(ws, "sessions.list").length;
    if (point === "queued reconciliation") {
      bootstrap.setForegroundRoute(host.sessionKey);
    }
    if (point !== "patch") {
      respond(ws, patch, createResolvedModelPatch(nextModel, "openai"));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests(ws, "sessions.list")).toHaveLength(
        listsBefore + (point === "in-flight reconciliation" ? 1 : 0),
      );
      expect(host.chatQueue[0]?.sendState).toBe("waiting-model");
    }
    ws.emitClose(1012, "controlled restart");
    await vi.advanceTimersByTimeAsync(0);
    await expect(selection).resolves.toBe(false);
    await sending;
    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    expect(host.chatQueue.some((item) => item.sendState === "waiting-model")).toBe(false);
    const retained = [host.chatMessage, ...host.chatQueue.map((item) => item.text)];
    expect(retained.filter((text) => text === message)).toHaveLength(1);
    expect(requests(ws, "chat.send")).toHaveLength(0);
    client.stop();
    bootstrap.setForegroundRoute(null);
    const replacement = await connect();
    await resumeStoredChatOutboxes(host);
    expect(host.chatQueue.some((item) => item.sendState === "waiting-model")).toBe(false);
    expect(requests(replacement, "chat.send")).toHaveLength(0);
    expect(sessions.state.loading).toBe(false);
  },
);

it("allows Remove during settings reconciliation without a late send", async () => {
  const { host, ws } = await fixture();
  const selection = switchChatModel(host, `openai/${nextModel}`);
  const sending = handleSendChat(host, undefined, undefined, new Event("submit"));
  await vi.advanceTimersByTimeAsync(0);
  const id = host.chatQueue[0]!.id;
  expect(removeQueuedMessage(host, id, { discard: true })).toBe("removed");
  respond(ws, requests(ws, "sessions.patch")[0]!, createResolvedModelPatch(nextModel, "openai"));
  await vi.advanceTimersByTimeAsync(0);
  respond(ws, requests(ws, "sessions.list").at(-1)!, roster);
  await vi.advanceTimersByTimeAsync(0);
  await expect(selection).resolves.toBe(true);
  await sending;
  expect(host.chatQueue).toEqual([]);
  expect(listStoredChatOutboxes(host)).toEqual([]);
  expect(requests(ws, "chat.send")).toHaveLength(0);
});

it.each([false, true])(
  "preserves an existing queue after an interrupted model change with newer draft: %s",
  async (newerDraft) => {
    const { host, ws, client, connect } = await fixture({ activeRun: true });
    host.chatRunId = "active-run";
    const backlog = ["First queued request", "Second queued request", "Third queued request"];
    for (const [index, text] of backlog.entries()) {
      host.chatMessage = text;
      host.chatAttachments = index === 1 ? [createStagedAttachment("queued-document")] : [];
      await handleSendChat(host, undefined, { followUpMode: "queue" });
    }
    expect(host.chatQueue.map((item) => item.text)).toEqual(backlog);
    const queued = host.chatQueue.map(({ id, sendRunId, orderKey }) => [id, sendRunId, orderKey]);
    const selection = switchChatModel(host, `openai/${nextModel}`);
    host.chatMessage = message;
    const admitted = createDeferred();
    const sending = handleSendChat(
      host,
      undefined,
      { followUpMode: "queue", onOutboxAdmitted: admitted.resolve },
      new Event("submit"),
    );
    await admitted.promise;
    const interrupted = host.chatQueue.at(-1)!;
    expect(interrupted).toMatchObject({
      text: message,
      sendState: "waiting-model",
      sendAttempts: 0,
    });
    if (newerDraft) {
      host.chatMessage = "Keep my newer draft";
    }
    ws.emitClose(1012, "controlled restart with a queued backlog");
    await vi.advanceTimersByTimeAsync(0);
    await expect(selection).resolves.toBe(false);
    await sending;
    client.stop();
    const replacement = await connect();
    await resumeStoredChatOutboxes(host);

    expect(
      host.chatQueue
        .slice(0, backlog.length)
        .map(({ id, sendRunId, orderKey }) => [id, sendRunId, orderKey]),
    ).toEqual(queued);
    expect(host.chatQueue.map((item) => item.text)).toEqual(
      newerDraft ? [...backlog, message] : backlog,
    );
    expect(host.chatMessage).toBe(newerDraft ? "Keep my newer draft" : message);
    if (newerDraft) {
      expect(host.chatQueue.at(-1)).toMatchObject({
        id: interrupted.id,
        sendState: "failed",
        sendAttempts: 0,
      });
    }
    const payload = await prepareOutboxPayload(host, host.chatQueue[1]!);
    expect(payload.status).toBe("ready");
    if (payload.status !== "ready") {
      throw new Error("The existing queued attachment could not be restored");
    }
    expect(getChatAttachmentDataUrl(payload.update.attachments![0]!)).toBe(
      "data:application/pdf;base64,JVBERi0xLjQK",
    );
    expect(requests(ws, "chat.send")).toHaveLength(0);
    expect(requests(replacement, "chat.send")).toHaveLength(0);
  },
);

it.each([
  { payload: "text", newerDraft: false },
  { payload: "text", newerDraft: true },
  { payload: "attachment", newerDraft: false },
  { payload: "attachment", newerDraft: true },
] as const)(
  "recovers interrupted $payload input with newer draft: $newerDraft",
  async ({ payload, newerDraft }) => {
    const withAttachment = payload === "attachment";
    const { host, ws, client, connect } = await fixture();
    if (withAttachment) {
      host.chatAttachments = [createStagedAttachment("settings-document")];
    }
    const selection = switchChatModel(host, `openai/${nextModel}`);
    const admitted = createDeferred();
    const sending = handleSendChat(
      host,
      undefined,
      { onOutboxAdmitted: admitted.resolve },
      new Event("submit"),
    );
    await admitted.promise;
    const original = host.chatQueue[0]!;
    if (newerDraft) {
      host.chatMessage = "Keep my newer draft";
    }
    expect(original).toMatchObject({ text: message, sendState: "waiting-model", sendAttempts: 0 });
    ws.emitClose(1012, "controlled restart during input yield");
    await vi.advanceTimersByTimeAsync(0);
    await expect(selection).resolves.toBe(false);
    await sending;
    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    expect(host.chatQueue.some((item) => item.sendState === "waiting-model")).toBe(false);
    if (!newerDraft) {
      expect(host.chatQueue).toEqual([]);
      expect(host.chatMessage).toBe(message);
      expect(host.chatAttachments).toHaveLength(withAttachment ? 1 : 0);
      if (withAttachment) {
        expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(
          "data:application/pdf;base64,JVBERi0xLjQK",
        );
      }
    } else {
      expect(host.chatMessage).toBe("Keep my newer draft");
      expect(host.chatQueue[0]).toMatchObject({
        id: original.id,
        sendRunId: original.sendRunId,
        text: message,
        sendState: "failed",
        sendAttempts: 0,
        sendError: "Chat settings update was interrupted. Review and retry when ready.",
      });
    }
    expect(requests(ws, "chat.send")).toHaveLength(0);
    client.stop();
    const replacement = await connect();
    await resumeStoredChatOutboxes(host);
    if (newerDraft) {
      expect(host.chatQueue[0]?.sendState).toBe("failed");
      expect(host.chatMessage).toBe("Keep my newer draft");
      expect(host.chatAttachments).toEqual([]);
      if (withAttachment) {
        const prepared = await prepareOutboxPayload(host, host.chatQueue[0]!);
        expect(prepared.status).toBe("ready");
        if (prepared.status !== "ready") {
          throw new Error("The retained queued attachment could not be restored");
        }
        expect(getChatAttachmentDataUrl(prepared.update.attachments![0]!)).toBe(
          "data:application/pdf;base64,JVBERi0xLjQK",
        );
      }
      expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("removed");
    } else {
      expect(host.chatMessage).toBe(message);
      if (withAttachment) {
        expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(
          "data:application/pdf;base64,JVBERi0xLjQK",
        );
      }
    }
    expect(host.chatQueue).toEqual([]);
    expect(requests(replacement, "chat.send")).toHaveLength(0);
  },
);
