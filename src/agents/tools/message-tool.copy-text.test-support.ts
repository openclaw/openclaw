import { describe, expect, it } from "vitest";
import { normalizeMessagePresentation } from "../../interactive/payload.js";
import { sanitizeMessageToolVisiblePayload } from "./message-tool-visible-content.js";

describe("message tool copy-text sanitization", () => {
  it("preserves safe copy text while stripping internal-only values and legacy aliases", () => {
    const internalContext =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const params = {
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Copy safe text",
                action: {
                  type: "copy-text",
                  text: `  SAFE-PREFIX\n${internalContext}\nSAFE-SUFFIX  `,
                },
              },
              {
                label: "Copy one space",
                action: { type: "copy-text", text: " " },
              },
              {
                label: "Copy internal text",
                action: { type: " Copy-Text ", text: internalContext },
                value: "must-not-become-active",
                callbackData: "must-not-become-active-camel",
                callback_data: "must-not-become-active-snake",
                url: "https://legacy.example.test",
              },
            ],
          },
        ],
      },
    };

    sanitizeMessageToolVisiblePayload(params);

    expect(params.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy safe text",
              action: { type: "copy-text", text: "  SAFE-PREFIX\n\nSAFE-SUFFIX  " },
            },
            {
              label: "Copy one space",
              action: { type: "copy-text", text: " " },
            },
            { label: "Copy internal text" },
          ],
        },
      ],
    });
    expect(normalizeMessagePresentation(params.presentation)?.blocks).toEqual([
      {
        type: "buttons",
        buttons: [
          {
            label: "Copy safe text",
            action: { type: "copy-text", text: "  SAFE-PREFIX\n\nSAFE-SUFFIX  " },
          },
          {
            label: "Copy one space",
            action: { type: "copy-text", text: " " },
          },
        ],
      },
    ]);
  });

  it("preserves literal escaped line breaks in copy-text actions", () => {
    const copyText = String.raw`line one\nline two\r\nline three`;
    const params = {
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Copy exact text",
                action: { type: "copy-text", text: copyText },
              },
            ],
          },
        ],
      },
    };

    sanitizeMessageToolVisiblePayload(params);

    expect(params.presentation.blocks[0]?.buttons[0]?.action.text).toBe(copyText);
  });
});
