import { describe, expect, it } from "vitest";

import { renderDeferredBatch } from "./deferred-render.js";

describe("deferred-render", () => {
  it("renders batches only from explicit display payloads", () => {
    expect(
      renderDeferredBatch({
        title: "[Queued messages while agent was busy]",
        summary: "1 older message summarized",
        items: [
          { visibility: "user-visible", text: "hello" },
          { visibility: "summary-only", summaryLine: "queued follow-up summary" },
        ],
      }),
    ).toContain("Queued #1\nhello");
  });

  it("rejects deferred render items without explicit display content", () => {
    expect(() =>
      renderDeferredBatch({
        title: "[Queued messages while agent was busy]",
        items: [{ visibility: "user-visible", text: "   " }],
      }),
    ).toThrow(/renderable deferred item #1/);
  });
});
