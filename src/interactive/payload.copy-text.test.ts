import { describe, expect, it } from "vitest";
import {
  normalizeMessagePresentation,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "./payload.js";

describe("copy-text presentation actions", () => {
  it("preserves exact nonempty copy text through normalization and the legacy bridge", () => {
    const copyText = "\n openclaw status \n";
    const normalized = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text", text: copyText },
            },
          ],
        },
      ],
    });

    expect(normalized).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text", text: copyText },
            },
          ],
        },
      ],
    });
    expect(presentationToInteractiveReply(normalized!)).toEqual(normalized);
  });

  it("rejects empty copy text while preserving whitespace-only values", () => {
    expect(
      normalizeMessagePresentation({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Copy", action: { type: "copy-text", text: "" } }],
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      normalizeMessagePresentation({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Copy space", action: { type: "copy-text", text: " " } }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Copy space", action: { type: "copy-text", text: " " } }],
        },
      ],
    });
  });

  it("renders simple copy text inline and multiline/backtick values in a complete fence", () => {
    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Copy token", action: { type: "copy-text", text: "TOKEN-7319" } }],
            },
          ],
        },
      }),
    ).toBe("- Copy token: `TOKEN-7319`");

    const copyText = "line one\nline ```two```";
    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Copy value", action: { type: "copy-text", text: copyText } }],
            },
          ],
        },
      }),
    ).toBe(`- Copy value:\n\`\`\`\`\n${copyText}\n\`\`\`\``);
  });

  it.each(["TOKEN\r7319", "TOKEN\u20287319", "TOKEN\u20297319", "TOKEN\r\n7319"])(
    "fences a value containing a non-inline line break (%j)",
    (copyText) => {
      expect(
        renderMessagePresentationFallbackText({
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Copy value", action: { type: "copy-text", text: copyText } }],
              },
            ],
          },
        }),
      ).toBe(`- Copy value:\n\`\`\`\n${copyText}\n\`\`\``);
    },
  );
});
