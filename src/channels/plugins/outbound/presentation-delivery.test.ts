import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import * as presentationPayload from "../../../interactive/payload.js";
import type { MessagePresentation } from "../../../interactive/payload.js";
import type { ChannelPresentationCapabilities } from "../outbound.types.js";
import { renderPresentationForDelivery } from "./presentation-delivery.js";

function createHandler(capabilities: ChannelPresentationCapabilities) {
  return {
    presentationCapabilities: { supported: true, ...capabilities },
    renderPresentation: vi.fn(async (payload: ReplyPayload) => payload),
  };
}

const tablePresentation: MessagePresentation = {
  title: "Status",
  blocks: [
    {
      type: "table",
      caption: "Session status",
      headers: ["Item", "Value"],
      rows: [["Model", "anthropic/claude-haiku-4-5"]],
    },
  ],
};
const fallbackPayload = {
  text: "Model: anthropic/claude-haiku-4-5\nUptime: 42s\nReference UTC: 12:00",
  presentation: tablePresentation,
  presentationTextMode: "fallback" as const,
};

describe("renderPresentationForDelivery", () => {
  it.each([
    ["one button", 1, 25, 5, 5, true],
    ["Discord-sized controls", 25, 25, 5, 5, true],
    ["Telegram-sized controls", 100, 100, 3, undefined, false],
  ] as const)(
    "adapts %s once before native rendering",
    async (_name, count, maxActions, perRow, maxRows, styles) => {
      const buttons = Array.from({ length: count }, (_, index) => ({
        label: `Choice ${index}`,
        action: { type: "callback" as const, value: `choice:${index}` },
      }));
      const presentation: MessagePresentation = {
        title: "Choose",
        blocks: [{ type: "buttons", buttons }],
      };
      const payload = { text: "Body", presentation };
      const expectedHeading = { title: "Choose", tone: undefined };
      const expectedInput = structuredClone(presentation);
      const expectedButtons = structuredClone(buttons);
      const normalizedButtons = expectedButtons.map((button) => ({ ...button, style: undefined }));
      const adaptedButtons = styles ? normalizedButtons : expectedButtons;
      const blocks = Array.from({ length: Math.ceil(count / perRow) }, (_, index) => ({
        type: "buttons",
        buttons: adaptedButtons.slice(index * perRow, (index + 1) * perRow),
      }));
      const handler = createHandler({
        buttons: true,
        limits: {
          actions: { maxActions, maxActionsPerRow: perRow, maxRows, supportsStyles: styles },
        },
      });
      const resolveAction = vi.spyOn(presentationPayload, "resolveMessagePresentationButtonAction");
      try {
        const rendered = await renderPresentationForDelivery(handler, payload);
        expect(rendered).toStrictEqual({ text: "Body" });
        expect(resolveAction).toHaveBeenCalledTimes(count);
      } finally {
        resolveAction.mockRestore();
      }

      expect(presentation).toStrictEqual(expectedInput);
      expect(handler.renderPresentation.mock.calls).toStrictEqual([
        [
          { text: "Body", presentation: { ...expectedHeading, blocks } },
          { ...expectedHeading, blocks: [{ type: "buttons", buttons: normalizedButtons }] },
        ],
      ]);
    },
  );
  it.each([
    ["a table", tablePresentation],
    [
      "a table with native context",
      {
        ...tablePresentation,
        blocks: [...tablePresentation.blocks, { type: "context", text: "Uptime: 42s" }],
      } satisfies MessagePresentation,
    ],
  ] as const)("preserves authored fallback for %s", async (_name, presentation) => {
    const handler = createHandler({ tables: false, context: true });
    const rendered = await renderPresentationForDelivery(handler, {
      ...fallbackPayload,
      presentation,
    });

    expect(rendered).toStrictEqual({ text: fallbackPayload.text });
    expect(handler.renderPresentation).not.toHaveBeenCalled();
  });

  it("renders natively when the channel keeps table blocks", async () => {
    const handler = createHandler({ tables: true });
    handler.renderPresentation.mockImplementation(async (payload) => ({
      ...payload,
      text: "native table rendering",
    }));
    const rendered = await renderPresentationForDelivery(handler, fallbackPayload);

    expect(handler.renderPresentation).toHaveBeenCalledTimes(1);
    expect(rendered).toStrictEqual({ text: "native table rendering" });
  });

  it("still renders interactive presentations through the channel renderer", async () => {
    const handler = createHandler({ buttons: true, tables: false });
    await renderPresentationForDelivery(handler, {
      ...fallbackPayload,
      presentation: {
        blocks: [
          ...tablePresentation.blocks,
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      },
    });

    expect(handler.renderPresentation).toHaveBeenCalledTimes(1);
  });
});
