// Regression coverage for surrogate-safe truncation in acp-projector session update text.
import { describe, expect, it } from "vitest";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = { kind: string; text?: string };

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const cu = value.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      if (
        i + 1 >= value.length ||
        !(value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff)
      ) {
        return true;
      }
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      if (i === 0 || !(value.charCodeAt(i - 1) >= 0xd800 && value.charCodeAt(i - 1) <= 0xdbff)) {
        return true;
      }
    }
  }
  return false;
}

describe("acp-projector truncation surrogate-safe", () => {
  it("does not produce lone surrogates when status text is truncated at an emoji boundary", async () => {
    const deliveries: Delivery[] = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            // resolveAcpProjectionSettings clamps to min 64.
            // truncateText does .slice(0, maxChars-1) = .slice(0, 63).
            maxSessionUpdateChars: 64,
            tagVisibility: { memory_summary: true },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    // 62 'a' + emoji + 10 'b' = 74 chars > 64 → triggers truncation.
    // Unsafe .slice(0, 63) captures 62 'a' + high surrogate → lone surrogate.
    await projector.onEvent({
      type: "status",
      tag: "memory_summary",
      text: "a".repeat(62) + "\u{1F389}" + "b".repeat(10), // 62+2+10=74
    });
    await projector.flush(true);

    const allText = deliveries
      .map((d) => d.text ?? "")
      .filter(Boolean)
      .join(" ");
    // Verify the text was actually truncated (not silently passing)
    expect(allText.length).toBeLessThan(74);
    // Verify no lone surrogates (would fail on main's .slice)
    expect(hasLoneSurrogate(allText)).toBe(false);
  });
});
