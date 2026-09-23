import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { adaptMessagePresentationForChannel } from "../../channels/plugins/outbound/presentation-limits.js";
import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForMirror } from "./payloads.js";

describe("outbound mirror text", () => {
  it("preserves normalized control order and plain-text precedence", () => {
    const payload: ReplyPayload = {
      presentation: {
        title: "  Card  ",
        blocks: [
          { type: "context", text: " context " },
          { type: "text", text: " body " },
          {
            type: "buttons",
            buttons: [
              { label: " Same ", value: "first" },
              { label: "Same", value: "second" },
              { label: " \t ", value: "ignored" },
            ],
          },
          {
            type: "select",
            placeholder: " Select ",
            options: [
              { label: " Choice ", value: "choice" },
              { label: "  ", value: "ignored" },
            ],
          },
        ],
      },
      interactive: {
        blocks: [
          { type: "text", text: " Legacy " },
          { type: "buttons", buttons: [{ label: " Accept ", value: "accept" }] },
          { type: "select", placeholder: " Old ", options: [{ label: " One ", value: "one" }] },
        ],
      },
    };
    const before = structuredClone(payload);

    expect(projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan([payload]))).toEqual({
      text: "Card\ncontext\nbody\nSame\nSame\nSelect\nChoice\nLegacy\nAccept\nOld\nOne",
      mediaUrls: [],
    });
    expect(
      projectOutboundPayloadPlanForMirror(
        createOutboundPayloadPlan([{ ...payload, text: "Caption" }]),
      ),
    ).toEqual({ text: "Caption", mediaUrls: [] });
    expect(payload).toEqual(before);
  });

  it("trims adapted continuation fragments and drops blank continuation context", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        title: "Head    Tail",
        blocks: [{ type: "context", text: "body        tail" }],
      },
      capabilities: { limits: { text: { maxLength: 6, encoding: "characters" } } },
    });
    const before = renderMessagePresentationFallbackText({ presentation });

    expect(
      projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan([{ presentation }])),
    ).toEqual({ text: "Head\nTail\nbody\ntail", mediaUrls: [] });
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(before);
  });
});
