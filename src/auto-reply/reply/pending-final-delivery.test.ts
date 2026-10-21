import { expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import {
  classifyHeartbeatPendingFinalDelivery,
  sanitizePendingFinalDeliveryText as sanitizeText,
} from "./pending-final-delivery-state.js";
import {
  buildRecoverablePendingFinalDeliveryText as recoverText,
  normalizePendingFinalDeliveryPayloads as deliveryPayloads,
  normalizePendingFinalRecoveryPayloads as recoveryPayloads,
  resolvePendingFinalDeliveryCompletion,
} from "./pending-final-delivery.js";

function expectRecovery(payloads: ReplyPayload[], text?: string) {
  expect(recoverText(payloads)).toBe(text);
}

it("persists the session writer authority with durable final custody", () => {
  const custody = {
    deliveryId: "delivery-1",
    intentId: "intent-1",
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:direct:1",
    storePath: "/tmp/sessions.json",
  };
  const authority = {
    agentId: "main",
    expectedLifecycleRevision: "revision-a",
    expectedSessionId: "session-1",
    expectedWriterRunId: "run-a",
    sessionKey: custody.sessionKey,
    storePath: custody.storePath,
  };
  const expected = {
    kind: "pending-final",
    ...custody,
    sessionWriterDeliveryAuthority: { ...authority },
  };
  const payload = setReplyPayloadMetadata(
    { text: "settled final" },
    {
      pendingFinalDeliveryCompletion: custody,
      sessionWriterDeliveryAuthority: authority,
    },
  );

  expect(resolvePendingFinalDeliveryCompletion([payload])).toEqual(expected);
});

it.each(["no_r", "NO_R", "NO_REPLY"])(
  "keeps pending ordinary reply %s during heartbeat admission",
  (text) => {
    expect(classifyHeartbeatPendingFinalDelivery(text, 300)).toEqual({
      shouldClear: false,
      replayText: text,
    });
  },
);

it("strips internal metadata from durable pending delivery text", () => {
  const text = [
    "Visible reply",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "internal detail",
    INTERNAL_RUNTIME_CONTEXT_END,
    "",
    markInboundContextLabel("Conversation info:"),
    "```json",
    '{"message_id":"msg-1"}',
    "```",
  ].join("\n");

  expect(sanitizeText(text)).toBe("Visible reply");
});

it.each([
  "    const value = 1;\n    use(value);",
  "NO_REPLY",
  '"NO_REPLY"',
  '{"action":"NO_REPLY"}',
  "NO_REPLY.",
  "NO_REPLYThe user is saying hello",
  "HEARTBEAT_OK NO_REPLY",
  "NO_REPLY\nAnswer.\n    Code.",
])("preserves prepared text without reinterpreting it: %s", (text) =>
  expect(sanitizeText(text)).toBe(text),
);

it("keeps media directives in the durable recovery text while sendable delivery parses them", () => {
  const text = "Rendered chart\nMEDIA:/tmp/chart.png";
  const rawPayloads = [{ text }];
  expect(recoveryPayloads(rawPayloads).map((payload) => payload.text)).toEqual([text]);
  expect(deliveryPayloads(rawPayloads).map((payload) => payload.text)).toEqual(["Rendered chart"]);
});

it("encodes structured media URLs as durable media directives", () => {
  expectRecovery(
    [{ text: "Rendered chart", mediaUrl: "/tmp/chart.png" }],
    "Rendered chart\nMEDIA:/tmp/chart.png",
  );
  expectRecovery(
    [
      {
        text: "MEDIA:/tmp/c.png",
        mediaUrls: [" /tmp/a.png ", "/tmp/b.png", "/tmp/a.png", " "],
        mediaUrl: " /tmp/b.png ",
      },
    ],
    "MEDIA:/tmp/a.png\nMEDIA:/tmp/b.png\nMEDIA:/tmp/c.png",
  );
  expectRecovery([{ text: "Visible", mediaUrl: " " }], "Visible");
});

it.each<ReplyPayload[]>([
  [{ text: "Pick one", interactive: { blocks: [{ type: "buttons", buttons: [] }] } }],
  [{ text: "Secret image", mediaUrl: "/tmp/secret.png", sensitiveMedia: true }],
  [{ text: "[[reply_to_current]] visible final" }],
  [
    { text: "A", mediaUrl: "/tmp/a.png" },
    { text: "B", mediaUrl: "/tmp/b.png" },
  ],
  [{ text: "A\nMEDIA:/tmp/a.png" }, { text: "B" }],
])("refuses recovery that would lose payload semantics: %j", (...payloads) => {
  expectRecovery(payloads);
});

it("separates implicit delivery threading from explicit reply semantics", () => {
  expectRecovery([{ text: "Visible final", replyToId: "source-message" }], "Visible final");

  const explicitReply = { text: "Visible final", replyToId: "source-message" };
  setReplyPayloadMetadata(explicitReply, { replyToIdExplicit: true });
  expectRecovery([explicitReply]);
});

it("preserves ordinary prose previously treated as silence", () => {
  expectRecovery(
    [{ text: "No channel reply." }, { text: "visible final" }],
    "No channel reply.\n\nvisible final",
  );
  expectRecovery([{ text: "No channel reply." }], "No channel reply.");
});
