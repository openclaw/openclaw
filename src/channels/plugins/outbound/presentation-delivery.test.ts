import { afterEach, describe, expect, it, vi } from "vitest";
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

const tableBlock = {
  type: "table" as const,
  caption: "Session status",
  headers: ["Item", "Value"],
  rows: [["Model", "anthropic/claude-haiku-4-5"]],
};
const fallbackPayload = {
  text: "Model: anthropic/claude-haiku-4-5\nUptime: 42s\nReference UTC: 12:00",
  presentation: { title: "Status", blocks: [tableBlock] },
  presentationTextMode: "fallback" as const,
};

describe("renderPresentationForDelivery", () => {
  afterEach(() => vi.restoreAllMocks());

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
      const expectedHeading = { title: "Choose", tone: undefined };
      const expectedInput = structuredClone(presentation);
      const normalizedButtons = buttons.map((button) => ({ ...button, style: undefined }));
      const adaptedButtons = styles ? normalizedButtons : buttons;
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
      const rendered = await renderPresentationForDelivery(handler, { text: "Body", presentation });
      expect(rendered).toStrictEqual({ text: "Body" });
      expect(resolveAction).toHaveBeenCalledTimes(count);
      expect(presentation).toStrictEqual(expectedInput);
      expect(handler.renderPresentation.mock.calls).toStrictEqual([
        [
          { text: "Body", presentation: { ...expectedHeading, blocks } },
          { ...expectedHeading, blocks: [{ type: "buttons", buttons: normalizedButtons }] },
        ],
      ]);
    },
  );
  it.each([false, true])("preserves authored fallback (native context: %s)", async (context) => {
    const handler = createHandler({ tables: false, context: true });
    const presentation: MessagePresentation = { title: "Status", blocks: [tableBlock] };
    if (context) {
      presentation.blocks.push({ type: "context", text: "Uptime: 42s" });
    }
    const rendered = await renderPresentationForDelivery(handler, {
      ...fallbackPayload,
      presentation,
    });
    expect(rendered).toStrictEqual({ text: fallbackPayload.text });
    expect(handler.renderPresentation).not.toHaveBeenCalled();
  });

  it.each([true, false])("renders natively with table support: %s", async (tables) => {
    const handler = createHandler({ tables, buttons: true });
    handler.renderPresentation.mockImplementation(async (payload) => ({
      ...payload,
      text: "native rendering",
    }));
    const presentation: MessagePresentation = { title: "Status", blocks: [tableBlock] };
    if (!tables) {
      presentation.blocks.push({ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] });
    }
    expect(
      await renderPresentationForDelivery(handler, { ...fallbackPayload, presentation }),
    ).toStrictEqual({ text: "native rendering" });
    expect(handler.renderPresentation).toHaveBeenCalledTimes(1);
  });
});
