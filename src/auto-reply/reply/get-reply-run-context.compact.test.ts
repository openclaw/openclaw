import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildCompactCurrentInboundFields } from "./get-reply-run-context.compact.js";
import { buildCompactInboundUserContextPrefix } from "./inbound-meta.compact.js";

const compactInboundContext = {
  text: "Context: short facts",
  removedSessionMessages: 0,
  deduplicatedMessages: 0,
};

describe("buildCompactCurrentInboundFields fragments", () => {
  it("keeps the delivery directive an instruction and the facts quoted data", () => {
    const fields = buildCompactCurrentInboundFields({
      compactInboundContext,
      sessionCtx: {} as TemplateContext,
      isRoomEvent: false,
      deliveryDirective: "Reply with message(action=send).",
      roomEventPrompt: "Room event.",
      promptJoiner: undefined,
      buildRoomEventContext: (roomContext) => roomContext,
    });

    expect(fields.compactFragments).toEqual([
      { kind: "conversation-data", text: "Context: short facts" },
      { kind: "runtime-instruction", text: "Reply with message(action=send)." },
    ]);
  });

  it("puts the room event prompt first as an instruction", () => {
    const fields = buildCompactCurrentInboundFields({
      compactInboundContext,
      sessionCtx: {} as TemplateContext,
      isRoomEvent: true,
      deliveryDirective: "Stay silent unless addressed.",
      roomEventPrompt: "Room event.",
      promptJoiner: undefined,
      buildRoomEventContext: (roomContext) => `Room event.\n\n${roomContext}`,
    });

    expect(fields.compactFragments).toEqual([
      { kind: "runtime-instruction", text: "Room event." },
      { kind: "conversation-data", text: "Context: short facts" },
      { kind: "runtime-instruction", text: "Stay silent unless addressed." },
    ]);
  });

  it("emits no data fragment for an empty projection", () => {
    const fields = buildCompactCurrentInboundFields({
      compactInboundContext: { ...compactInboundContext, text: "" },
      sessionCtx: {} as TemplateContext,
      isRoomEvent: false,
      deliveryDirective: undefined,
      roomEventPrompt: "Room event.",
      promptJoiner: undefined,
      buildRoomEventContext: (roomContext) => roomContext,
    });

    expect(fields.compactFragments).toEqual([]);
  });
});

describe("buildCompactCurrentInboundFields Telegram current message", () => {
  const sessionCtx = {
    ChatType: "direct",
    Provider: "telegram",
    Surface: "telegram",
    MessageSid: "123",
    Body: "what about tomorrow?",
    BodyForAgent: "what about tomorrow?",
    ReplyToBody: "lunch at noon",
  } as TemplateContext;

  it("puts the current body in the standalone fragment and keeps the inline header bare", () => {
    const compact = buildCompactInboundUserContextPrefix(sessionCtx);
    const fields = buildCompactCurrentInboundFields({
      compactInboundContext: {
        text: compact.text,
        removedSessionMessages: 0,
        deduplicatedMessages: 0,
      },
      sessionCtx,
      isRoomEvent: false,
      deliveryDirective: undefined,
      roomEventPrompt: "Room event.",
      promptJoiner: " ",
      buildRoomEventContext: (roomContext) => roomContext,
    });

    const data = fields.compactFragments.find((fragment) => fragment.kind === "conversation-data");
    expect(data?.text).toContain("#123: what about tomorrow?");
    expect(fields.compactText.endsWith("#123:")).toBe(true);
    expect(fields.compactText).not.toContain("what about tomorrow?");
  });
});
