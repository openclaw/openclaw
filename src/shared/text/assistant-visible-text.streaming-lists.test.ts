import { expect, it } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";

it("preserves literal code and correction deltas across list boundaries", () => {
  const label = "ß".repeat(600);
  const cases = [
    [
      "tool call: hidden\n- item\n# heading\nParagraph `\n2. step\n",
      "tool call: literal\nend`\n",
      true,
    ],
    ["tool call: hidden\n- item `open\n  2. step\n", "  tool call: literal\n  end`\n", true],
    [
      "tool call: hidden\n-     code\n  paragraph `open\n   2. step\n",
      "  tool call: literal\n  end`\n",
      true,
    ],
    ["tool call: hidden\n- item `open\n-", "continuation\ntool call: literal\nend`\n", true],
    [
      `- item\n\n  [${label}]: /url\n\n- next\n`,
      `  ![example \`x\ntool call: literal\nx\`][${label}]\n`,
      false,
    ],
  ] as const;
  for (const [first, second, keepsLiteral] of cases) {
    const stream = createAssistantVisibleStreamText();
    let source = "";
    let delivered = "";
    for (const chunk of [first, second]) {
      source += chunk;
      const result = stream.append(chunk);
      delivered = result.delta === null ? result.text : delivered + result.delta;
      const expected = sanitizeAssistantVisibleStreamText(source);
      expect(result.text).toBe(expected);
      expect(delivered).toBe(expected);
    }
    expect(stream.text.includes("tool call: literal")).toBe(keepsLiteral);
  }
});
