import assert from "node:assert/strict";
import { beforeEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  markCommandReplyForDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { readSessionTranscriptContextMessages } from "../config/sessions/session-accessor.sqlite-model-context.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

const roleAndText = (messages: Iterable<{ role: string }>) =>
  Array.from(messages, (message) => ({ role: message.role, text: extractFirstTextBlock(message) }));

beforeEach(() => dispatchInboundMessageMock.mockReset());

test.each([
  ["pure", "/status", "Status: idle.", false],
  ["mixed", "/status plugins", "Plugin status: ready.", true],
] as const)(
  "chat command transcript context: %s retains visible history and correct model context",
  async (kind, input, reply, contextual) => {
    const sessionKey = `agent:main:command-context-${kind}`;
    const runId = `command-context-${kind}`;
    try {
      const created = await rpcReq(ws, "sessions.create", { key: sessionKey, agentId: "main" });
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      dispatchInboundMessageMock.mockImplementationOnce(async ({ dispatcher }) => {
        const finalPayload = { text: reply };
        const marked = kind === "pure" ? finalPayload : { text: reply };
        setReplyPayloadMetadata(marked, { contextFreeCommand: true });
        markCommandReplyForDelivery(marked);
        if (kind === "mixed") {
          dispatcher.sendBlockReply(marked);
        }
        const queuedFinal = dispatcher.sendFinalReply(finalPayload);
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return { queuedFinal, counts: dispatcher.getQueuedCounts() };
      });

      const finalPromise = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat" &&
          event.payload?.state === "final" &&
          event.payload?.runId === runId,
        10_000,
      );
      const [sent, final] = await Promise.all([
        rpcReq(ws, "chat.send", {
          sessionKey,
          message: input,
          idempotencyKey: runId,
        }),
        finalPromise,
      ]);
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      expect(extractFirstTextBlock(final.payload?.message)).toBe(reply);

      const history = await rpcReq<{ messages: Array<{ role: string }> }>(ws, "chat.history", {
        sessionKey,
      });
      expect(history.ok, JSON.stringify(history)).toBe(true);
      const exchange = [
        { role: "user", text: input },
        { role: "assistant", text: reply },
      ];
      expect(roleAndText(history.payload?.messages ?? [])).toEqual(exchange);
      const { agentId, canonicalKey, entry, storePath } =
        await loadGatewaySessionEntryReadOnlyAsync(sessionKey);
      assert(entry, `chat.send must create ${sessionKey}`);
      const modelContext = readSessionTranscriptContextMessages(
        { agentId, sessionId: entry.sessionId, sessionKey: canonicalKey, storePath },
        roleAndText,
      );
      expect(modelContext).toEqual(contextual ? exchange : []);
    } finally {
      // The final event can precede dispatch cleanup; settle it before the suite resets runtime.
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      dispatchInboundMessageMock.mockReset();
    }
  },
);
