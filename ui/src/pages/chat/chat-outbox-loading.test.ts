// @vitest-environment jsdom
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost, makeRequestMock, expectRequestCounts } from "./chat-host.test-support.ts";
import { admitHostQueueItems, idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { queued as makeQueued } from "./chat-thread-fixtures.test-support.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

afterEach(() => vi.doUnmock("./chat-outbox-readiness.ts"));

it.each([
  "current",
  "connection epoch",
  "client replacement",
  "disconnect",
  "load failure",
  "load failure after reconnect",
] as const)("retains outbox ownership across recovery module loading (%s)", async (scenario) => {
  const sessionKey = "agent:main:outbox-loading";
  const history = idleChatHistory(sessionKey);
  history.sessionInfo.sessionId = "outbox-session";
  const host = createTestPageState(
    makeChatHost({
      sessionKey,
      currentSessionId: "outbox-session",
      chatQueue: [
        makeQueued("retained-input", "Retained outbox message", 1, "waiting-idle", {
          sessionKey,
          sendRunId: "next-run",
        }),
      ],
      requestHandlers: {
        "chat.history": history,
        "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
      },
    }),
  );
  admitHostQueueItems(host);
  const renderedErrors: Array<string | null | undefined> = [];
  const dispose = createRoot((stop) => {
    createEffect(
      () => host.chatError,
      (value) => {
        renderedErrors.push(value);
      },
    );
    return stop;
  });
  flush();

  const started = createDeferred();
  const ready = createDeferred();
  vi.doMock("./chat-outbox-readiness.ts", async () => {
    started.resolve();
    await ready.promise;
    return vi.importActual<typeof import("./chat-outbox-readiness.ts")>(
      "./chat-outbox-readiness.ts",
    );
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
    expectRequestCounts(host.request, { "chat.history": 0, "chat.send": 0 });
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
    flush();

    if (scenario === "current") {
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.[1]).toMatchObject({ sessionKey, message: "Retained outbox message" });
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } else {
      expectRequestCounts(host.request, { "chat.history": 0, "chat.send": 0 });
      expect(listStoredChatOutboxes(host)).toEqual(queued);
      if (scenario === "load failure") {
        expect(host.chatError?.trim()).not.toBe("");
        expect(host.lastError).toBe(host.chatError);
        expect(renderedErrors).toContain(host.chatError);
      } else {
        expect(host).toMatchObject({ chatError: null, lastError: null });
        expect(renderedErrors).toEqual([]);
      }
    }
  } finally {
    dispose();
    ready.resolve();
    await draining;
  }
});
