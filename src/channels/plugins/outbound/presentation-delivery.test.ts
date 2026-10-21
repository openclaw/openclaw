import { describe, expect, it, vi } from "vitest";
import * as presentationPayload from "../../../interactive/payload.js";
import type { MessagePresentation } from "../../../interactive/payload.js";
import { renderPresentationForDelivery } from "./presentation-delivery.js";

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
  text: "authored plain body",
  presentation: tablePresentation,
  presentationTextMode: "fallback" as const,
};

describe("renderPresentationForDelivery button adaptation", () => {
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
      const expectedInput = structuredClone(presentation);
      const expectedButtons = structuredClone(buttons);
      const normalizedButtons = expectedButtons.map((button) => ({ ...button, style: undefined }));
      const adaptedButtons = styles ? normalizedButtons : expectedButtons;
      const blocks = Array.from({ length: Math.ceil(count / perRow) }, (_, index) => ({
        type: "buttons",
        buttons: adaptedButtons.slice(index * perRow, (index + 1) * perRow),
      }));
      const renderPresentation = vi.fn(async (payload: { text?: string }) => payload);
      const resolveAction = vi.spyOn(presentationPayload, "resolveMessagePresentationButtonAction");
      try {
        const rendered = await renderPresentationForDelivery(
          {
            presentationCapabilities: {
              supported: true,
              buttons: true,
              limits: {
                actions: { maxActions, maxActionsPerRow: perRow, maxRows, supportsStyles: styles },
              },
            },
            renderPresentation,
          },
          { text: "Body", presentation },
        );
        expect(rendered).toStrictEqual({ text: "Body" });
        expect(resolveAction).toHaveBeenCalledTimes(count);
      } finally {
        resolveAction.mockRestore();
      }

      expect(presentation).toStrictEqual(expectedInput);
      expect(renderPresentation.mock.calls).toStrictEqual([
        [
          { text: "Body", presentation: { title: "Choose", tone: undefined, blocks } },
          {
            title: "Choose",
            tone: undefined,
            blocks: [{ type: "buttons", buttons: normalizedButtons }],
          },
        ],
      ]);
    },
  );
});

describe("renderPresentationForDelivery authored fallback", () => {
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
    const renderPresentation = vi.fn();
    const authoredText = "Model: anthropic/claude-haiku-4-5\nUptime: 42s\nReference UTC: 12:00";
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: { supported: true, tables: false, context: true },
        renderPresentation,
      },
      { ...fallbackPayload, text: authoredText, presentation },
    );

    expect(rendered.text).toBe(authoredText);
    expect(rendered.presentation).toBeUndefined();
    expect(renderPresentation).not.toHaveBeenCalled();
  });

  it("renders natively when the channel keeps table blocks", async () => {
    const renderPresentation = vi.fn(async (payload: { text?: string }) => ({
      ...payload,
      text: "native table rendering",
    }));
    const rendered = await renderPresentationForDelivery(
      { presentationCapabilities: { supported: true, tables: true }, renderPresentation },
      fallbackPayload,
    );

    expect(renderPresentation).toHaveBeenCalledTimes(1);
    expect(rendered.text).toBe("native table rendering");
    expect(rendered.presentation).toBeUndefined();
  });

  it("still renders interactive presentations through the channel renderer", async () => {
    const renderPresentation = vi.fn(async (payload: { text?: string }) => payload);
    await renderPresentationForDelivery(
      {
        presentationCapabilities: { supported: true, buttons: true, tables: false },
        renderPresentation,
      },
      {
        ...fallbackPayload,
        presentation: {
          blocks: [
            ...tablePresentation.blocks,
            { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
          ],
        },
      },
    );

    expect(renderPresentation).toHaveBeenCalledTimes(1);
  });
});
