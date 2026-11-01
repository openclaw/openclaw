/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import "../../lib/toast-host.tsx";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { expectRpc, findRequestPayload, makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { steerQueuedChatMessage, interruptQueuedChatMessage } from "./chat-send-actions.ts";
import { loadChatComposerState } from "./composer-draft-storage.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each(["steer", "interrupt"] as const)(
  "sends a queued row through the generic outbox with its durable %s mode",
  async (mode) => {
    const ack = createDeferred<unknown>();
    const original: ChatQueueItem = {
      id: "queued-steer",
      text: "tighten the plan",
      createdAt: 1,
      sendRunId: "stable-steer-send",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeChatHost({
      currentSessionId: "steer-session",
      requestHandlers: { "chat.send": () => ack.promise },
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    const admission = captureChatOutboxAdmission(host, host.sessionKey, original.agentId);
    expect(admitQueuedMessageForSession(host, admission, original)).toBe(true);

    const sending =
      mode === "steer"
        ? steerQueuedChatMessage(host, original.id)
        : interruptQueuedChatMessage(host, original.id);
    await waitForFast(() => expectRpc(host.request, "chat.send"));

    const payload = findRequestPayload(host.request, "chat.send", "queued steer payload");
    expect(payload).toMatchObject({
      sessionKey: original.sessionKey,
      message: original.text,
      queueMode: mode,
      idempotencyKey: original.sendRunId,
    });
    expect(payload).not.toHaveProperty("expectedRunId");
    if (mode === "steer") {
      expect(payload).not.toHaveProperty("expectedLeafEntryId");
    } else {
      expect(payload).toHaveProperty("expectedLeafEntryId", null);
    }
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: mode,
        sendRunId: original.sendRunId,
        sendState: "sending",
      }),
    ]);
    expect(loadChatComposerState(host, host.sessionKey).snapshot?.queue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: mode,
        sendRunId: original.sendRunId,
        sendState: "waiting-reconnect",
      }),
    ]);

    ack.resolve({ runId: original.sendRunId, status: "started" });
    await sending;
  },
);
