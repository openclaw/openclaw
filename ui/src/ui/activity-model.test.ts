// @vitest-environment node
import { describe, expect, it } from "vitest";
import { updateActivityFromToolEvent, type ActivityEntry } from "./activity-model.ts";

function buildResultPreview(result: unknown): string {
  const host = { activityEntries: [] as ActivityEntry[] };

  updateActivityFromToolEvent(host, {
    runId: "run-1",
    ts: 1,
    data: {
      toolCallId: "tool-1",
      name: "bash",
      phase: "result",
      result,
    },
  });

  const entry = host.activityEntries[0];
  if (!entry?.outputPreview) {
    throw new Error("Expected activity output preview");
  }
  return entry.outputPreview;
}

describe("activity model output preview redaction", () => {
  it("redacts dotted API key assignments emitted by tool output", () => {
    const preview = buildResultPreview({
      text: [
        "app.api.key=visible-leaked-value-1234567890",
        "spring.datasource.password=visible-db-password-1234567890",
        "server.port=8080",
      ].join("\n"),
    });

    expect(preview).toContain("app.api.key=[redacted]");
    expect(preview).toContain("spring.datasource.password=[redacted]");
    expect(preview).toContain("server.port=8080");
    expect(preview).not.toContain("visible-leaked-value-1234567890");
    expect(preview).not.toContain("visible-db-password-1234567890");
  });

  it("redacts dotted API keys in object-shaped tool results", () => {
    const preview = buildResultPreview({
      "app.api.key": 'visible secret with spaces, apostrophe: don\'t, quote: "keep hidden"',
      "server.port": 8080,
    });

    expect(preview).toContain('"app.api.key": "[redacted]"');
    expect(preview).toContain('"server.port": 8080');
    expect(preview).not.toContain("visible secret");
    expect(preview).not.toContain("keep hidden");
  });
});
