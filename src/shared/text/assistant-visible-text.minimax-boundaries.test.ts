import { describe, expect, it } from "vitest";
import { userFacingTextFilters } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { applyTextFilters, createTextProjection } from "./text-projection.js";

const payloads = [
  JSON.stringify({ command: 'printf "</invoke>"', note: "TAIL_SENTINEL" }),
  JSON.stringify({ command: "printf `", note: "TAIL_SENTINEL" }),
  "Write `</invoke>` followed by TAIL_SENTINEL.",
  "Don't display TAIL_SENTINEL.",
] as const;
const envelope = (payload: string) =>
  `Ready.
<minimax:tool_call><invoke name="exec">${payload}</invoke></minimax:tool_call>
Done.`;
const expected = `Ready.

Done.`;

describe("MiniMax argument boundary isolation", () => {
  it.each(payloads)("never projects argument tails at any split: %s", (payload) => {
    const input = envelope(payload);
    for (let split = 0; split <= input.length; split++) {
      for (const profile of ["delivery", "final-answer-delivery"] as const) {
        const projection = createTextProjection(assistantVisibleTextFilters(profile, true));
        expect(projection.append(input.slice(0, split)).text).not.toContain("TAIL_SENTINEL");
        expect(projection.append(input.slice(split)).text).toBe(expected);
      }
    }
  });

  it.each([false, true])("retains user-facing normal/error streaming policy: error=%s", (error) => {
    for (const streaming of [false, true]) {
      const filters = userFacingTextFilters(error, streaming);
      expect(userFacingTextFilters(error, streaming)).toBe(filters);
      for (const payload of payloads) {
        expect(applyTextFilters(envelope(payload), filters)).toBe(expected);
      }
      const malformed = envelope('{"note":"TAIL_SENTINEL}');
      expect(applyTextFilters(malformed, filters)).not.toContain("TAIL_SENTINEL");
    }
  });

  it("preserves internal scaffolding, caching and trailing whitespace", () => {
    const input = envelope(payloads[0]);
    const scaffolding = "<minimax:tool_call>PRIVATE_PAYLOAD</minimax:tool_call>";
    expect(applyTextFilters(scaffolding, assistantVisibleTextFilters("internal-scaffolding"))).toBe(
      scaffolding,
    );
    const filters = assistantVisibleTextFilters("delivery", true, {
      preserveTrailingWhitespace: true,
    });
    expect(
      assistantVisibleTextFilters("delivery", true, { preserveTrailingWhitespace: true }),
    ).toBe(filters);
    expect(applyTextFilters(input + "   ", filters)).toBe(expected + "   ");
  });
});
