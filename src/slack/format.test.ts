import { describe, expect, it } from "vitest";
import {
  enforceIncidentLabelFormat,
  markdownToSlackMrkdwn,
  normalizeSlackOutboundText,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

describe("markdownToSlackMrkdwn", () => {
  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToSlackMrkdwn(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("does not throw when input is undefined at runtime", () => {
    expect(markdownToSlackMrkdwn(undefined as unknown as string)).toBe("");
  });
});

describe("escapeSlackMrkdwn", () => {
  it("returns plain text unchanged", () => {
    expect(escapeSlackMrkdwn("heartbeat status ok")).toBe("heartbeat status ok");
  });

  it("escapes slack and mrkdwn control characters", () => {
    expect(escapeSlackMrkdwn("mode_*`~<&>\\")).toBe("mode\\_\\*\\`\\~&lt;&amp;&gt;\\\\");
  });
});

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*");
  });

  it("enforces bold incident labels after normalization", () => {
    // Model writes _Incident:_ (Slack italic) → normalizer preserves → enforcer fixes to bold
    expect(normalizeSlackOutboundText("_Incident:_ crash")).toBe("*Incident:* crash");
  });
});

describe("enforceIncidentLabelFormat", () => {
  it("replaces italic incident labels with bold", () => {
    const input = `_Incident:_ Server crash
_Customer impact:_ confirmed
_Affected services:_ api
_Status:_ investigating`;
    const expected = `*Incident:* Server crash
*Customer impact:* confirmed
*Affected services:* api
*Status:* investigating`;
    expect(enforceIncidentLabelFormat(input)).toBe(expected);
  });

  it("replaces all known labels", () => {
    const labels = [
      "Incident",
      "Customer impact",
      "Affected services",
      "Status",
      "Evidence",
      "Likely cause",
      "Mitigation",
      "Validate",
      "Next",
      "Also watching",
      "Auto-fix PR",
      "Linear",
      "Suggested PR",
      "Fix PR",
      "Context",
      "What the PR does",
    ];
    for (const label of labels) {
      expect(enforceIncidentLabelFormat(`_${label}:_ val`)).toBe(`*${label}:* val`);
    }
  });

  it("leaves already-bold labels unchanged", () => {
    const input = "*Incident:* crash\n*Status:* ok";
    expect(enforceIncidentLabelFormat(input)).toBe(input);
  });

  it("leaves non-label italic unchanged", () => {
    expect(enforceIncidentLabelFormat("_emphasis_ text")).toBe("_emphasis_ text");
  });
});
