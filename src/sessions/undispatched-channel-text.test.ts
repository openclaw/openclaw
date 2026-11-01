import { describe, expect, it } from "vitest";
import { readUndispatchedChannelText } from "./undispatched-channel-text.js";

describe("original undispatched channel input", () => {
  const message = { role: "user", content: "  original text  ", idempotencyKey: "input-1" };
  it("preserves the exact text", () => {
    expect(readUndispatchedChannelText(message, "input-1")).toBe(message.content);
  });
  it.each([
    { idempotencyKey: "other" },
    { role: "assistant" },
    { content: "" },
    { provenance: { kind: "internal_system" } },
    { display: false },
    { __openclaw: { media: [{ path: "photo.png" }] } },
    { __openclaw: { steerTargetRunId: "other" } },
  ])("refuses mismatched or non-text admission %o", (change) => {
    expect(readUndispatchedChannelText({ ...message, ...change }, "input-1")).toBeUndefined();
  });
});
