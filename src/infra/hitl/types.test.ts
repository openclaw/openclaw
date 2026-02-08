import { describe, expect, it } from "vitest";
import { parseHitlWebhookPayload } from "./types.js";

describe("parseHitlWebhookPayload", () => {
  it("parses completed decision", () => {
    const parsed = parseHitlWebhookPayload({
      event: "request.completed",
      request_id: "r1",
      response_data: { selected_value: "allow-once" },
      response_by: { name: "Alice" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual({
      kind: "completed",
      requestId: "r1",
      decision: "allow-once",
      resolvedBy: "Alice",
    });
  });

  it("treats unknown decision as ignored", () => {
    const parsed = parseHitlWebhookPayload({
      event: "request.completed",
      request_id: "r2",
      response_data: { selected_value: "banana" },
      response_by: { name: "Bob" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.kind).toBe("ignored");
  });
});
