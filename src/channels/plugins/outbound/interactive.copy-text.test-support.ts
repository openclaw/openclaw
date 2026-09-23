import { describe, expect, it } from "vitest";
import { adaptMessagePresentationForChannel } from "../../../plugin-sdk/interactive-runtime.js";

describe("copy-text presentation capabilities", () => {
  it("keeps copy-text buttons only when the channel opts in", () => {
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
});
