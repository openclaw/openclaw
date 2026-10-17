import { describe, expect, it } from "vitest";
import { adaptMessagePresentationForChannel } from "../../../plugin-sdk/interactive-runtime.js";

describe("copy-text presentation capabilities", () => {
  it("keeps copy-text buttons only when the channel explicitly opts in", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Copy token",
              action: { type: "copy-text" as const, text: "TOKEN-7319" },
            },
          ],
        },
      ],
    };

    expect(
      adaptMessagePresentationForChannel({ presentation, capabilities: { buttons: true } }).blocks,
    ).toEqual([{ type: "context", text: "Actions:\n- Copy token: `TOKEN-7319`" }]);
    expect(
      adaptMessagePresentationForChannel({
        presentation,
        capabilities: { buttons: true, copyTextButtons: true },
      }).blocks,
    ).toEqual(presentation.blocks);
  });

  it("counts every select option when a transport renders options as actions", () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      label: `Option ${String(index + 1)}`,
      value: `option:${String(index + 1)}`,
    }));
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Target", options },
          {
            type: "buttons",
            buttons: [
              {
                label: "Copy token",
                action: { type: "copy-text", text: "TOKEN-7319" },
              },
            ],
          },
        ],
      },
      capabilities: {
        copyTextButtons: true,
        limits: {
          actions: { maxActions: 100, maxActionsPerRow: 3 },
          selects: { maxOptions: 100, optionsConsumeActionBudget: true },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "select", placeholder: "Target", options },
      { type: "context", text: "Actions:\n- Copy token: `TOKEN-7319`" },
    ]);
  });

  it("keeps other channels on one action per native select", () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      label: `Option ${String(index + 1)}`,
      value: `option:${String(index + 1)}`,
    }));
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Target", options },
          {
            type: "buttons",
            buttons: [{ label: "Continue", value: "continue" }],
          },
        ],
      },
      capabilities: {
        limits: {
          actions: { maxActions: 2 },
          selects: { maxOptions: 100 },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "select", placeholder: "Target", options },
      { type: "buttons", buttons: [{ label: "Continue", value: "continue" }] },
    ]);
  });

  it("reserves one native row for every select before choosing Discord-sized buttons", () => {
    const buttons = Array.from({ length: 20 }, (_, index) => ({
      label: `Button ${String(index + 1)}`,
      value: `button:${String(index + 1)}`,
    }));
    const select = (placeholder: string) => ({
      type: "select" as const,
      placeholder,
      options: [{ label: `${placeholder} option`, value: placeholder.toLowerCase() }],
    });

    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [{ type: "buttons", buttons }, select("Environment"), select("Region")],
      },
      capabilities: {
        limits: {
          actions: { maxActions: 25, maxActionsPerRow: 5, maxRows: 5 },
          selects: { maxOptions: 25 },
        },
      },
    });

    expect(presentation.blocks).toEqual([
      { type: "buttons", buttons: buttons.slice(0, 5) },
      { type: "buttons", buttons: buttons.slice(5, 10) },
      { type: "buttons", buttons: buttons.slice(10, 15) },
      {
        type: "context",
        text: `Actions:\n${buttons
          .slice(15)
          .map((button) => `- ${button.label}`)
          .join("\n")}`,
      },
      select("Environment"),
      select("Region"),
    ]);
  });
});
