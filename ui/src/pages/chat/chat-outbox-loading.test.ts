// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

afterEach(() => vi.doUnmock("./chat-outbox-receipts.ts"));

it.each([
  "current",
  "connection epoch",
  "client replacement",
  "disconnect",
  "load failure",
  "load failure after reconnect",
] as const)("retains outbox ownership across recovery module loading (%s)", async (scenario) => {
  const sessionKey = "agent:main:outbox-loading";
  const host = makeChatHost({
    sessionKey,
    currentSessionId: "outbox-session",
    chatRunId: "finished-run",
    chatMessage: "Retained outbox message",
    chatError: null,
    lastError: null,
    requestHandlers: {
      "chat.history": {
        messages: [],
        sessionInfo: {
          key: sessionKey,
          sessionId: "outbox-session",
          kind: "direct",
          updatedAt: 2,
          status: "done",
          hasActiveRun: false,
          lastRunId: "finished-run",
        },
      },
      "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
    },
  });
  await handleSendChat(host, undefined, { followUpMode: "queue" });
  expect(host.chatQueue).toHaveLength(1);
  const renderedErrors: Array<string | null | undefined> = [];
  host.requestUpdate = () => {
    renderedErrors.push(host.chatError);
  };

  const started = createDeferred();
  const ready = createDeferred();
  vi.doMock("./chat-outbox-receipts.ts", async () => {
    started.resolve();
    await ready.promise;
    return vi.importActual<typeof import("./chat-outbox-receipts.ts")>("./chat-outbox-receipts.ts");
  });
  const draining = resumeStoredChatOutboxes(host);
  try {
    await Promise.race([
      started.promise,
      draining.then(() => {
        throw new Error("Outbox recovery completed before loading its module");
      }),
    ]);
    const queued = listStoredChatOutboxes(host);
    expect(queued).toHaveLength(1);
    expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    renderedErrors.length = 0;

    if (scenario === "connection epoch" || scenario === "load failure after reconnect") {
      host.connectionEpoch += 1;
    } else if (scenario === "client replacement") {
      host.client = createTestGatewayClient(makeRequestMock());
    } else if (scenario === "disconnect") {
      host.connected = false;
    }
    if (scenario.startsWith("load failure")) {
      ready.reject(new Error("Synthetic recovery module unavailable"));
    } else {
      ready.resolve();
    }
    await draining;

    if (scenario === "current") {
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything());
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.[1]).toMatchObject({ sessionKey, message: "Retained outbox message" });
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } else {
      expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(listStoredChatOutboxes(host)).toEqual(queued);
      if (scenario === "load failure") {
        expect(host.chatError).toEqual(expect.any(String));
        expect(host.chatError?.trim()).not.toBe("");
        expect(host.lastError).toBe(host.chatError);
        expect(renderedErrors).toContain(host.chatError);
      } else {
        expect(host.chatError).toBeNull();
        expect(host.lastError).toBeNull();
        expect(renderedErrors).toEqual([]);
      }
    }
  } finally {
    ready.resolve();
    await draining;
    host.sessions.dispose();
  }
});
