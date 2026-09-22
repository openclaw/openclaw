import assert from "node:assert/strict";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  markCommandReplyForDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { readSessionTranscriptContextMessages } from "../config/sessions/session-accessor.sqlite-model-context.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
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

function roleAndText(messages: readonly { role: string }[]) {
  return messages.map((message) => ({
    role: message.role,
    text: extractFirstTextBlock(message),
  }));
}

describe("chat command transcript context", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  test.each([
    {
      name: "pure context-free command",
      kind: "pure",
      input: "/status",
      reply: "Status: idle.",
      contextual: false,
    },
    {
      name: "marked block with an identical unmarked final",
      kind: "mixed",
      input: "/status plugins",
      reply: "Plugin status: ready.",
      contextual: true,
    },
    {
      name: "ordinary reply",
      kind: "ordinary",
      input: "Remember the project deadline.",
      reply: "The project deadline is Friday.",
      contextual: true,
    },
  ])("retains visible history and the correct model context for $name", async (scenario) => {
    const sessionKey = `agent:main:command-context-${scenario.kind}`;
    const runId = `command-context-${scenario.kind}`;
    try {
      const created = await rpcReq(ws, "sessions.create", { key: sessionKey, agentId: "main" });
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const { dispatcher } = args as Parameters<typeof dispatchInboundMessage>[0];
        const finalPayload = { text: scenario.reply };
        if (scenario.kind === "pure") {
          setReplyPayloadMetadata(finalPayload, { contextFreeCommand: true });
          markCommandReplyForDelivery(finalPayload);
        } else if (scenario.kind === "mixed") {
          const block = setReplyPayloadMetadata(
            { text: scenario.reply },
            { contextFreeCommand: true },
          );
          markCommandReplyForDelivery(block);
          dispatcher.sendBlockReply(block);
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
          message: scenario.input,
          idempotencyKey: runId,
        }),
        finalPromise,
      ]);
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      expect(extractFirstTextBlock(final.payload?.message)).toBe(scenario.reply);

      const history = await rpcReq<{ messages: Array<{ role: string }> }>(ws, "chat.history", {
        sessionKey,
      });
      expect(history.ok, JSON.stringify(history)).toBe(true);
      const exchange = [
        { role: "user", text: scenario.input },
        { role: "assistant", text: scenario.reply },
      ];
      expect(roleAndText(history.payload?.messages ?? [])).toEqual(exchange);
      const { agentId, canonicalKey, entry, storePath } =
        loadGatewaySessionEntryReadOnly(sessionKey);
      assert(entry, `chat.send must create ${sessionKey}`);
      const modelContext = readSessionTranscriptContextMessages(
        { agentId, sessionId: entry.sessionId, sessionKey: canonicalKey, storePath },
        (messages) => roleAndText([...messages]),
      );
      expect(modelContext).toEqual(scenario.contextual ? exchange : []);
    } finally {
      // The final event can precede dispatch cleanup; settle it before the suite resets runtime.
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      dispatchInboundMessageMock.mockReset();
    }
  });
});
