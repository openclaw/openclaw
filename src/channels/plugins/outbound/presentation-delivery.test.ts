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

describe("renderPresentationForDelivery button adaptation", () => {
  it.each([
    { name: "one button", count: 1, maxActions: 25, perRow: 5, maxRows: 5, styles: true },
    {
      name: "Discord-sized controls",
      count: 25,
      maxActions: 25,
      perRow: 5,
      maxRows: 5,
      styles: true,
    },
    {
      name: "Telegram-sized controls",
      count: 100,
      maxActions: 100,
      perRow: 3,
      maxRows: undefined,
      styles: false,
    },
  ])(
    "adapts $name once before native rendering",
    async ({ count, maxActions, perRow, maxRows, styles }) => {
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
      const expectedRendererCalls = [
        [
          { text: "Body", presentation: { title: "Choose", tone: undefined, blocks } },
          {
            title: "Choose",
            tone: undefined,
            blocks: [{ type: "buttons", buttons: normalizedButtons }],
          },
        ],
      ];
      const renderPresentation = vi
        .fn()
        .mockImplementation(async (payload: { text?: string }) => payload);
      const handler = {
        presentationCapabilities: {
          supported: true,
          buttons: true,
          limits: {
            actions: { maxActions, maxActionsPerRow: perRow, maxRows, supportsStyles: styles },
          },
        },
        renderPresentation,
      };
      const resolveAction = vi.spyOn(presentationPayload, "resolveMessagePresentationButtonAction");
      let actionReads = 0;
      let rendered: Awaited<ReturnType<typeof renderPresentationForDelivery>>;
      try {
        rendered = await renderPresentationForDelivery(handler, { text: "Body", presentation });
        actionReads = resolveAction.mock.calls.length;
      } finally {
        resolveAction.mockRestore();
      }

      expect(presentation).toStrictEqual(expectedInput);
      expect(renderPresentation.mock.calls).toStrictEqual(expectedRendererCalls);
      expect(rendered).toStrictEqual({ text: "Body" });
      expect(actionReads).toBe(count);
    },
  );
});

describe("renderPresentationForDelivery authored fallback", () => {
  it.each([
    { name: "a table", presentation: tablePresentation },
    {
      name: "a table with native context",
      presentation: {
        ...tablePresentation,
        blocks: [...tablePresentation.blocks, { type: "context", text: "Uptime: 42s" }],
      } satisfies MessagePresentation,
    },
  ])("preserves authored fallback for $name", async ({ presentation }) => {
    const renderPresentation = vi.fn();
    const handler = {
      presentationCapabilities: { supported: true, tables: false, context: true },
      renderPresentation,
    };
    const authoredText = "Model: anthropic/claude-haiku-4-5\nUptime: 42s\nReference UTC: 12:00";

    const rendered = await renderPresentationForDelivery(handler, {
      text: authoredText,
      presentation,
      presentationTextMode: "fallback",
    });

    expect(rendered.text).toBe(authoredText);
    expect(rendered.presentation).toBeUndefined();
    expect(renderPresentation).not.toHaveBeenCalled();
  });

  it("renders natively when the channel keeps table blocks", async () => {
    const renderPresentation = vi.fn().mockImplementation(async (payload: { text?: string }) => ({
      ...payload,
      text: "native table rendering",
    }));
    const handler = {
      presentationCapabilities: { supported: true, tables: true },
      renderPresentation,
    };

    const rendered = await renderPresentationForDelivery(handler, {
      text: "authored plain body",
      presentation: tablePresentation,
      presentationTextMode: "fallback",
    });

    expect(renderPresentation).toHaveBeenCalledTimes(1);
    expect(rendered.text).toBe("native table rendering");
    expect(rendered.presentation).toBeUndefined();
  });

  it("still renders interactive presentations through the channel renderer", async () => {
    const renderPresentation = vi
      .fn()
      .mockImplementation(async (payload: { text?: string }) => payload);
    const handler = {
      presentationCapabilities: { supported: true, buttons: true, tables: false },
      renderPresentation,
    };

    await renderPresentationForDelivery(handler, {
      text: "authored plain body",
      presentation: {
        blocks: [
          ...tablePresentation.blocks,
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      },
      presentationTextMode: "fallback",
    });

    expect(renderPresentation).toHaveBeenCalledTimes(1);
  });
});
