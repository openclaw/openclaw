import { describe, expect, test } from "vitest";
import type { MessagePresentation } from "../../../interactive/payload.js";
import type { ChannelPresentationCapabilities } from "../outbound.types.js";
import { adaptMessagePresentationForChannel } from "./presentation-limits.js";

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // High surrogate: lone if not followed by a low surrogate
      if (
        i + 1 >= text.length ||
        text.charCodeAt(i + 1) < 0xdc00 ||
        text.charCodeAt(i + 1) > 0xdfff
      ) {
        return true;
      }
      i++; // valid pair, skip low surrogate
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

const utf16Unit = (n: number) =>
  ({ maxLength: n, encoding: "utf16-units" }) as NonNullable<
    NonNullable<ChannelPresentationCapabilities["limits"]>["text"]
  >;

const noTables = {
  context: true,
  tables: false,
} satisfies Partial<ChannelPresentationCapabilities>;

describe("splitPresentationText (via adapter path)", () => {
  describe("empty-prefix handling (P2 fix)", () => {
    test("text starting with supplementary emoji at utf16-units limit 1", () => {
      // Build a realistic table so fallback text starts with emoji caption
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "🎉 Sales",
            headers: ["A"],
            rows: [["Value"]],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(1) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      // The 🎉 (2 units) should be dropped entirely rather than producing a
      // lone surrogate or pushing the entire untruncated text as one block.
      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          // Block text should not exceed limit
          expect(b.text.length).toBeLessThanOrEqual(1);
        }
      }
    });

    test("text starting with supplementary emoji at utf16-units limit 2", () => {
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "🎉 Sales",
            headers: ["A"],
            rows: [["Hello"]],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(2) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      // 🎉 fits exactly in 2 units, so we should see a block starting with 🎉
      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          expect(b.text.length).toBeLessThanOrEqual(2);
        }
      }
    });

    test("multiple emoji at start with tiny utf16-units limit", () => {
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "a table",
            headers: ["🎉", "🚀"],
            rows: [["💡", "📱"]],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(1) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          expect(b.text.length).toBeLessThanOrEqual(1);
        }
      }
    });

    test("long emoji-only fallback with tiny utf16-units limit", () => {
      // Generated fallback text is entirely supplementary-plane emoji.
      // With limit=1, each emoji (2 UTF-16 units) must be dropped one by
      // one; no empty blocks, no lone surrogates, no monolithic bail-out.
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "🎉🎉🎉",
            headers: ["🚀🚀"],
            rows: [["💡💡"]],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(1) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      expect(result.blocks.length).toBeGreaterThan(0);
      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          expect(b.text.length).toBeLessThanOrEqual(1);
          // No block should start with a partial emoji
          if (b.text.length === 1) {
            const cp = b.text.codePointAt(0);
            expect(cp).not.toBeUndefined();
            expect(cp! <= 0xffff).toBe(true);
          }
        }
      }
    });

    test("normal ASCII text still splits correctly", () => {
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "Results",
            headers: ["Name", "Score"],
            rows: [
              ["Alice", "95"],
              ["Bob", "87"],
              ["Charlie", "92"],
            ],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(10) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      expect(result.blocks.length).toBeGreaterThan(1);
      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          expect(b.text.length).toBeLessThanOrEqual(10);
        }
      }
    });
  });

  describe("no lone surrogates across utf16-units encoding paths", () => {
    test("text block with emoji at truncation boundary", () => {
      const p: MessagePresentation = {
        blocks: [
          {
            type: "text",
            text: "a".repeat(1999) + "🚀",
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        limits: { text: utf16Unit(2000) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      expect(result.blocks.length).toBe(1);
      const block = result.blocks[0];
      if (block.type === "text") {
        expect(hasLoneSurrogate(block.text)).toBe(false);
        // Should retreat past the surrogate pair
        expect(block.text.length).toBeLessThanOrEqual(1999);
      }
    });

    test("realistic table fallback with emoji throughout", () => {
      const p: MessagePresentation = {
        blocks: [
          {
            type: "table",
            caption: "🎉 Sales 2024",
            headers: ["Product", "🚀 Revenue", "Growth 📈"],
            rows: [
              ["Rocket", 100000, "15%"],
              ["Lightbulb 💡", 85000, "22%"],
            ],
          },
        ],
      };
      const caps: ChannelPresentationCapabilities = {
        ...noTables,
        limits: { text: utf16Unit(50) },
      };
      const result = adaptMessagePresentationForChannel({ presentation: p, capabilities: caps });

      expect(result.blocks.length).toBeGreaterThan(0);
      for (const b of result.blocks) {
        if (b.type === "context" || b.type === "text") {
          expect(hasLoneSurrogate(b.text)).toBe(false);
          expect(b.text.length).toBeLessThanOrEqual(50);
        }
      }
    });
  });
});
